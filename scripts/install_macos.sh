#!/bin/bash
# Downloads as the user; only the bundle transaction may request administrator authorization.
# Only runs the verified App's dependency check; never opens the editor/Codex or changes preferences/security.
set -euo pipefail
PACKAGE_URL='@PACKAGE_URL@'
PACKAGE_SHA256='@PACKAGE_SHA256@'
APP_FILENAME='@APP_FILENAME@'
APP_VERSION='@APP_VERSION@'
SYSTEM_APP_PATH='/Applications/Codex Slider.app'
APP_PATH="${CODEX_SLIDER_APP_PATH:-/Applications/$APP_FILENAME}"
LEGACY_ROOT="$HOME/Applications"
fail() { printf 'Codex Slider: %s\n' "$*" >&2; exit 1; }
[[ "$EUID" != 0 ]] || fail 'Run the installer as your normal user. It requests administrator authorization when needed.'
[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail 'This app requires macOS.'
[[ "$(/usr/bin/uname -m)" == arm64 ]] || fail 'This build requires Apple Silicon. Use a native Terminal session.'
OS_VERSION="$(/usr/bin/sw_vers -productVersion)"
[[ "${OS_VERSION%%.*}" -ge 15 ]] || fail 'This app requires macOS 15 or later.'
[[ "$PACKAGE_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'The installer has no valid pinned checksum.'
[[ "$APP_VERSION" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || fail 'The installer has no valid pinned app version.'
case "$PACKAGE_URL" in
  https://*) PROTOCOL='=https' ;;
  http://127.0.0.1:*) PROTOCOL='=http' ;; # Local verification only.
  *) fail 'The installer has no valid download address.' ;;
esac
case "$APP_PATH" in /*.app) ;; *) fail 'The destination must be an absolute .app path.' ;; esac
[[ "$APP_PATH" != *$'\n'* ]] || fail 'The destination contains an unsupported character.'
PARENT="$(/usr/bin/dirname "$APP_PATH")"
if [[ ! -d "$PARENT" ]]; then /bin/mkdir -p "$PARENT"; fi
PARENT="$(cd "$PARENT" && /bin/pwd -P)"
APP_PATH="$PARENT/$(/usr/bin/basename "$APP_PATH")"
identity() {
  [[ -d "$1" && ! -L "$1" && ! -L "$1/Contents" && ! -L "$1/Contents/Info.plist" ]] || return 1
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist")" == dev.codexslider.app ]] || return 1
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$1/Contents/Info.plist")" == CodexSlider ]] || return 1
  /usr/bin/codesign --verify --deep --strict "$1"
}
version_allowed() {
  local old part
  local old_parts new_parts
  old="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist")"
  [[ "$old" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || fail 'The existing app version could not be checked.'
  IFS=. read -r -a old_parts <<< "$old"
  IFS=. read -r -a new_parts <<< "$APP_VERSION"
  for part in 0 1 2; do
    (( 10#${old_parts[$part]} <= 10#${new_parts[$part]} )) || fail 'An installed app is newer than this installer. It was left unchanged.'
    if (( 10#${old_parts[$part]} < 10#${new_parts[$part]} )); then break; fi
  done
}
ensure_closed() {
  local pid command processes cwd
  processes="$(/bin/ps -axo pid=,comm=)" || fail 'Running apps could not be checked.'
  while read -r pid command; do
    case "$command" in
      "$1/Contents/MacOS/CodexSlider"|"$1/Contents/Resources/runtime/bin/node")
        fail "Close Codex Slider before upgrading: $1. Your app was left unchanged." ;;
      */node)
        cwd="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null || true)"
        if [[ "$cwd" == *$'\nn'"$1/Contents/Resources/app"$'\n'* || "$cwd" == *$'\nn'"$1/Contents/Resources/app" ]]; then
          fail "Close Codex Slider before upgrading: $1. Your app was left unchanged."
        fi ;;
    esac
  done <<< "$processes"
}
app_id() { /usr/bin/stat -f '%d:%i:%m:%c' "$1"; }
check_existing() {
  if [[ -e "$1" || -L "$1" ]]; then
    identity "$1" || fail "The item is not a verified Codex Slider app. It was left unchanged: $1"
    version_allowed "$1"
    ensure_closed "$1"
  fi
}
WORK=''; MOUNT=''; MOUNTED=0; DISK_IMAGE_TOOL='hdiutil'; COMPLETE=0
LEGACY_PATHS=(); LEGACY_IDS=(); LEGACY_STAGES=()
MAIN_LOCK="${TMPDIR:-/tmp}/codex-slider-install-$UID.lock"
/bin/mkdir "$MAIN_LOCK" 2>/dev/null || fail 'Another installation is in progress. Check an interrupted installation before removing its lock.'
detach_image() {
  if [[ "$DISK_IMAGE_TOOL" == diskutil ]]; then /usr/sbin/diskutil eject "$MOUNT" >/dev/null
  else /usr/bin/hdiutil detach -quiet "$MOUNT"; fi
}
cleanup() {
  local i old stage
  for ((i=0;i<${#LEGACY_STAGES[@]};i++)); do
    old="${LEGACY_PATHS[$i]}"; stage="${LEGACY_STAGES[$i]}"
    if [[ "$COMPLETE" == 0 && -e "$stage/previous.app" ]]; then
      if [[ ! -e "$old" && ! -L "$old" ]]; then /bin/mv -n "$stage/previous.app" "$old" || true; fi
      if [[ -e "$stage/previous.app" ]]; then
        printf 'Codex Slider: Your previous app was kept at %s.\n' "$stage/previous.app" >&2
        continue
      fi
    fi
    /bin/rm -rf "$stage"
  done
  if [[ "$MOUNTED" == 1 ]] && ! detach_image; then
    printf 'Codex Slider: Eject the disk image at %s. Temporary files were kept.\n' "$MOUNT" >&2
    /bin/rmdir "$MAIN_LOCK" || true
    return
  fi
  [[ -z "$WORK" ]] || /bin/rm -rf "$WORK"
  /bin/rmdir "$MAIN_LOCK" || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
check_existing "$APP_PATH"
EXPECTED_ID='absent'
if [[ -e "$APP_PATH" ]]; then EXPECTED_ID="$(app_id "$APP_PATH")"; fi
# Only system installation migrates the current user's known historical names.
if [[ "$APP_PATH" == "$SYSTEM_APP_PATH" ]]; then
  for NAME in 'Codex Slider.app' 'Codex Slider Command Test.app'; do
    LEGACY="$LEGACY_ROOT/$NAME"
    if [[ -e "$LEGACY" || -L "$LEGACY" ]]; then
      check_existing "$LEGACY"
      LEGACY_PATHS+=("$LEGACY")
      LEGACY_IDS+=("$(app_id "$LEGACY")")
    fi
  done
fi
WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/codex-slider-install.XXXXXX")"
MOUNT="$WORK/mount"
if [[ -n "${CODEX_SLIDER_PACKAGE_FILE:-}" ]]; then
  [[ "$CODEX_SLIDER_PACKAGE_FILE" == /* && -f "$CODEX_SLIDER_PACKAGE_FILE" && ! -L "$CODEX_SLIDER_PACKAGE_FILE" ]] || \
    fail 'The downloaded package must be an existing absolute file, not a symbolic link.'
  printf 'Verifying downloaded Codex Slider...\n'
  /bin/cp "$CODEX_SLIDER_PACKAGE_FILE" "$WORK/download.dmg"
else
  printf 'Downloading Codex Slider...\n'
  /usr/bin/curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 \
    --proto "$PROTOCOL" --proto-redir '=https' "$PACKAGE_URL" --output "$WORK/download.dmg"
fi
ACTUAL="$(/usr/bin/shasum -a 256 "$WORK/download.dmg")"
[[ "${ACTUAL%% *}" == "$PACKAGE_SHA256" ]] || fail 'Download verification failed. Nothing was installed.'
printf 'Download verified.\n'
/bin/mkdir "$MOUNT"
ATTACH_HELP="$(/usr/sbin/diskutil image attach 2>&1 || true)"
if [[ "$ATTACH_HELP" == *'--readOnly'* && "$ATTACH_HELP" == *'--mountOptions'* && "$ATTACH_HELP" == *'--mountPoint'* ]]; then
  DISK_IMAGE_TOOL='diskutil'
  /usr/sbin/diskutil image attach --readOnly --mountOptions nobrowse --mountPoint "$MOUNT" "$WORK/download.dmg" >/dev/null
else
  /usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$WORK/download.dmg" >/dev/null
fi
MOUNTED=1
SOURCE="$MOUNT/Codex Slider.app"
identity "$SOURCE" || fail 'The app identity or signature is unexpected.'
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SOURCE/Contents/Info.plist")" == "$APP_VERSION" ]] || fail 'The app version is unexpected.'
printf 'Checking external Node.js...\n'
"$SOURCE/Contents/MacOS/CodexSlider" --check-node >/dev/null || fail 'Install a compatible Node.js 22, 24 or 26 runtime using the instructions above, then run this installer again. No apps were replaced.'
printf 'Compatible Node.js found.\n'

# Only this fixed transaction program may execute as administrator.
transaction_cleanup() {
  if [[ "$TX_COMMITTED" == 0 && -n "$TX_BACKUP" && -e "$TX_BACKUP" ]]; then
    if [[ ! -e "$APP_PATH" && ! -L "$APP_PATH" ]]; then /bin/mv -n "$TX_BACKUP" "$APP_PATH" || true; fi
    if [[ -e "$TX_BACKUP" ]]; then
      printf 'Codex Slider: The previous system app was kept at %s.\n' "$TX_BACKUP" >&2
      TX_STAGE=''
    fi
  fi
  [[ -z "$TX_STAGE" ]] || /bin/rm -rf "$TX_STAGE"
  if [[ "$TX_LOCKED" == 1 ]]; then /bin/rmdir "$TX_LOCK" || true; fi
}
permission_failure() {
  case "$1" in *'Permission denied'*|*'Operation not permitted'*) return 0 ;; *) return 1 ;; esac
}
install_transaction() {
  export LC_ALL=C
  local parent name attempt
  parent="$(/usr/bin/dirname "$APP_PATH")"; name="$(/usr/bin/basename "$APP_PATH")"
  [[ ! -L "$parent" && -d "$parent" ]] || fail 'The installation folder changed.'
  identity "$SOURCE" || fail 'The new app could not be verified.'
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SOURCE/Contents/Info.plist")" == "$APP_VERSION" ]] || fail 'The new app version changed.'
  TX_STAGE=''; TX_BACKUP=''; TX_COMMITTED=0; TX_LOCKED=0
  TX_LOCK="$parent/.$name.install-lock"
  trap transaction_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if attempt="$(/usr/bin/mktemp -d "$parent/.codex-slider-install.XXXXXX" 2>&1)"; then TX_STAGE="$attempt"
  else
    if permission_failure "$attempt"; then exit 77; fi
    fail "$attempt"
  fi
  /bin/mkdir "$TX_LOCK" 2>/dev/null || fail 'Another installation is in progress. Check its lock before trying again.'
  TX_LOCKED=1
  /usr/bin/ditto "$SOURCE" "$TX_STAGE/$name"
  identity "$TX_STAGE/$name" || fail 'The staged app could not be verified.'
  if [[ "$EXPECTED_ID" != absent ]]; then
    [[ ! -L "$APP_PATH" && -d "$APP_PATH" && "$(app_id "$APP_PATH")" == "$EXPECTED_ID" ]] || fail 'The destination changed during installation.'
    check_existing "$APP_PATH"
    TX_BACKUP="$TX_STAGE/previous.app"
    if attempt="$(/bin/mv "$APP_PATH" "$TX_BACKUP" 2>&1)"; then :
    else
      if permission_failure "$attempt"; then exit 77; fi
      fail "$attempt"
    fi
  else
    [[ ! -e "$APP_PATH" && ! -L "$APP_PATH" ]] || fail 'The destination appeared during installation. It was left unchanged.'
  fi
  /bin/mv -n "$TX_STAGE/$name" "$parent/"
  [[ ! -e "$TX_STAGE/$name" ]] || fail 'The destination changed during installation. Nothing was replaced.'
  TX_COMMITTED=1
}
TRANSACTION_MAIN="$(cat <<'TRANSACTION_MAIN'
SOURCE="$1"; APP_PATH="$2"; APP_VERSION="$3"; EXPECTED_ID="$4"
[[ "$APP_VERSION" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || fail 'Invalid installation version.'
if [[ "$EUID" == 0 && "$APP_PATH" != '/Applications/Codex Slider.app' ]]; then
  fail 'Administrator installation is restricted to /Applications/Codex Slider.app.'
fi
install_transaction
TRANSACTION_MAIN
)"
# Bind the program before authorization. Root must never reopen code from a
# user-writable staging path after the administrator approves the operation.
TRANSACTION_PROGRAM=$'set -euo pipefail\n'"$(declare -f fail identity version_allowed ensure_closed app_id check_existing permission_failure transaction_cleanup install_transaction)"$'\n'"$TRANSACTION_MAIN"
for ((I=0;I<${#LEGACY_PATHS[@]};I++)); do
  LEGACY="${LEGACY_PATHS[$I]}"
  [[ ! -L "$LEGACY" && -d "$LEGACY" && "$(app_id "$LEGACY")" == "${LEGACY_IDS[$I]}" ]] || fail 'A personal app changed during installation.'
  check_existing "$LEGACY"
  LEGACY_STAGE="$(/usr/bin/mktemp -d "$LEGACY_ROOT/.codex-slider-migrate.XXXXXX")"
  LEGACY_STAGES+=("$LEGACY_STAGE")
  /bin/mv "$LEGACY" "$LEGACY_STAGE/previous.app"
done
STATUS=0
/bin/bash --noprofile --norc -c "$TRANSACTION_PROGRAM" codex-slider-install "$SOURCE" "$APP_PATH" "$APP_VERSION" "$EXPECTED_ID" || STATUS=$?
if [[ "$STATUS" == 77 && "$APP_PATH" == "$SYSTEM_APP_PATH" ]]; then
  printf 'Administrator authorization is required to install Codex Slider in /Applications.\n'
  /usr/bin/osascript - "$TRANSACTION_PROGRAM" "$SOURCE" "$APP_PATH" "$APP_VERSION" "$EXPECTED_ID" <<'APPLESCRIPT' || fail 'Administrator authorization was canceled or installation failed. Your personal app will be restored.'
on run argv
    set commandText to "/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash --noprofile --norc -c " & quoted form of (item 1 of argv) & " codex-slider-install"
    repeat with argument in items 2 thru -1 of argv
        set commandText to commandText & " " & quoted form of (contents of argument)
    end repeat
    do shell script commandText with administrator privileges
end run
APPLESCRIPT
elif [[ "$STATUS" != 0 ]]; then
  if [[ "$STATUS" == 77 ]]; then fail 'The chosen development destination is not writable.'; fi
  exit "$STATUS"
fi
COMPLETE=1
printf '\nCodex Slider is installed.\nLocation: %s\n' "$APP_PATH"
if ! /usr/bin/open -R "$APP_PATH"; then printf 'Open this location in Finder: %s\n' "$APP_PATH" >&2; fi
printf 'This preview is not Apple-notarized. macOS may still require Open Anyway.\n'
