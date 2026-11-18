import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {VERSION} from '../src/core.mjs';
import {REPOSITORY, renderInstaller, sha256} from '../scripts/release.mjs';

const template = fs.readFileSync(new URL('../scripts/install_macos.sh', import.meta.url), 'utf8');
const payload = 'fixture for the published disk image\n';
const shell = '#!/bin/bash\nset -eu\n';

// Run a disposable copy with macOS commands replaced by fixtures. Both branches
// execute under the test user, and every writable path is inside this directory.
function install(t, mode) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slider-install-test-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const system = path.join(root, 'system');
  const legacy = path.join(root, 'legacy');
  const destination = path.join(system, 'Codex Slider.app');
  const oldPersonal = path.join(legacy, 'Codex Slider.app');
  const temp = path.join(root, 'tmp');
  const packageFile = path.join(root, 'package.dmg');
  const traceFile = path.join(root, 'trace');
  for (const dir of [system, legacy, temp]) fs.mkdirSync(dir);
  fs.writeFileSync(packageFile, payload);
  fs.writeFileSync(traceFile, '');
  fs.writeFileSync(path.join(root, 'settings.json'), '{"saved":true}');
  if (mode !== 'no-node') {
    const node = path.join(root, 'homebrew', 'bin', 'node');
    fs.mkdirSync(path.dirname(node), {recursive:true});
    fs.writeFileSync(node, shell + '[[ "$1" == --input-type=commonjs && "$2" == -e ]]\n', {mode:0o755});
  }

  function bundle(dir, marker) {
    fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), {recursive:true});
    fs.writeFileSync(path.join(dir, 'marker'), marker);
    fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), '');
    fs.writeFileSync(path.join(dir, 'Contents', 'MacOS', 'CodexSlider'),
      shell + 'exit 137\n', {mode:0o755});
  }
  bundle(destination, 'installed');
  bundle(oldPersonal, 'legacy');
  bundle(path.join(root, 'source.app'), 'release');

  const shims = {
    '/usr/bin/uname': 'case "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 9;; esac',
    '/usr/bin/sw_vers': 'echo 15.0',
    '/bin/ps': 'exit 0',
    '/usr/sbin/lsof': 'exit 9',
    '/usr/libexec/PlistBuddy': [
      'case "$2" in',
      '  "Print :CFBundleIdentifier") echo dev.codexslider.app;;',
      '  "Print :CFBundleExecutable") echo CodexSlider;;',
      '  "Print :CFBundleShortVersionString") echo "$SLIDER_FIXTURE_VERSION";;',
      '  *) exit 9;;',
      'esac',
    ].join('\n'),
    '/usr/bin/codesign': 'exit 0',
    '/usr/bin/stat': 'echo 1:2:3:4',
    '/usr/sbin/diskutil': 'exit 1',
    '/usr/bin/hdiutil': [
      'if [[ "$1" == attach && "$2" == -readonly ]]; then',
      '  printf "mount %s %s\\n" "$SLIDER_FIXTURE_EUID" "$6" >> "$SLIDER_FIXTURE_TRACE"',
      '  /bin/cp -R "$SLIDER_FIXTURE_ROOT/source.app" "$5/Codex Slider.app"',
      'elif [[ "$1" == detach ]]; then',
      '  printf "detach %s\\n" "$SLIDER_FIXTURE_EUID" >> "$SLIDER_FIXTURE_TRACE"',
      'else exit 9; fi',
    ].join('\n'),
    '/usr/bin/mktemp': [
      'if [[ "$SLIDER_FIXTURE_MODE" != normal && "$SLIDER_FIXTURE_EUID" == 501 && "$2" == "$SLIDER_FIXTURE_ROOT"/system/* ]]; then',
      '  echo "Permission denied" >&2; exit 1',
      'fi',
      'exec /usr/bin/mktemp "$@"',
    ].join('\n'),
    '/usr/bin/ditto': 'printf "copy %s %s\\n" "$SLIDER_FIXTURE_EUID" "$1" >> "$SLIDER_FIXTURE_TRACE"\nexec /bin/cp -R "$1" "$2"',
    '/usr/bin/open': 'exit 0',
    '/usr/bin/osascript': [
      '/bin/cat >/dev/null',
      '[[ "$1" == "-" ]]; program="$2"; shift 2',
      'printf "authorize\\n" >> "$SLIDER_FIXTURE_TRACE"',
      'case "$SLIDER_FIXTURE_MODE" in',
      '  changed) printf "changed package\\n" > "$1";;',
      '  symlink) /bin/rm "$1"; /bin/ln -s "$CODEX_SLIDER_PACKAGE_FILE" "$1";;',
      '  cancel) exit 1;;',
      'esac',
      'SLIDER_FIXTURE_EUID=0 exec /bin/bash --noprofile --norc -c "$program" slider-test "$@"',
    ].join('\n'),
    '/usr/bin/curl': 'exit 9',
  };

  let script = renderInstaller(template, {repository:REPOSITORY, sourceSha:'a'.repeat(40), version:VERSION,
    buildRunId:'101', candidateRunId:'102'}, sha256(payload))
    .replaceAll('/Applications/Codex Slider.app', destination)
    .replace('LEGACY_ROOT="$HOME/Applications"', 'LEGACY_ROOT="$SLIDER_FIXTURE_ROOT/legacy"')
    .replaceAll('/opt/homebrew/', root + '/homebrew/')
    .replaceAll('/usr/local/', root + '/local/')
    .replaceAll('$HOME', '$SLIDER_FIXTURE_ROOT/runtime-user')
    .replaceAll('/private/tmp/codex-slider-admin.', temp + '/codex-slider-admin.')
    .replaceAll('$EUID', '$SLIDER_FIXTURE_EUID');
  for (const [command, body] of Object.entries(shims)) {
    assert(script.includes(command), 'Expected to replace ' + command);
    const shim = path.join(root, path.basename(command));
    fs.writeFileSync(shim, shell + body + '\n', {mode:0o755});
    script = script.replaceAll(command, shim);
  }
  assert.doesNotMatch(script, /\/(?:usr\/)?(?:bin|sbin|libexec)\/(?:hdiutil|diskutil|osascript|open|curl|codesign|PlistBuddy|lsof)\b/);
  const program = path.join(root, 'install.sh');
  fs.writeFileSync(program, script);
  const result = spawnSync('/bin/bash', [program], {encoding:'utf8', timeout:10000, env:{
    PATH:'/usr/bin:/bin', TMPDIR:temp, CODEX_SLIDER_APP_PATH:destination, CODEX_SLIDER_PACKAGE_FILE:packageFile,
    SLIDER_FIXTURE_ROOT:root, SLIDER_FIXTURE_EUID:'501', SLIDER_FIXTURE_MODE:mode,
    SLIDER_FIXTURE_VERSION:VERSION, SLIDER_FIXTURE_TRACE:traceFile,
  }});
  assert.ifError(result.error);
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), '{"saved":true}');
  assert.deepEqual(fs.readdirSync(temp), []);
  return {
    status:result.status, output:result.stdout + result.stderr,
    trace:fs.readFileSync(traceFile, 'utf8'),
    installed:fs.readFileSync(path.join(destination, 'marker'), 'utf8'),
    personal:fs.existsSync(oldPersonal) && fs.readFileSync(path.join(oldPersonal, 'marker'), 'utf8'),
  };
}

test('ordinary install and administrator fallback install the verified package', t => {
  const ordinary = install(t, 'normal');
  assert.equal(ordinary.status, 0, ordinary.output);
  assert.equal(ordinary.installed, 'release');
  assert.equal(ordinary.personal, false);
  assert.match(ordinary.trace, /^mount 501 /m);
  assert.doesNotMatch(ordinary.trace, /authorize/);

  const admin = install(t, 'admin');
  assert.equal(admin.status, 0, admin.output);
  assert.equal(admin.installed, 'release');
  assert.equal(admin.personal, false);
  assert.match(admin.trace, /detach 501\nauthorize\nmount 0 .*\/codex-slider-admin\.[^/]+\/download\.dmg\ncopy 0 .*\/codex-slider-admin\.[^/]+\/mount\//);
  assert.match(admin.trace, /^detach 0$/m);
});

test('changed or symbolic packages and canceled authorization preserve both existing apps', t => {
  for (const mode of ['changed', 'symlink', 'cancel']) {
    const result = install(t, mode);
    assert.notEqual(result.status, 0, mode);
    if (mode === 'changed') assert.match(result.output, /Administrator package verification failed/);
    if (mode === 'symlink') assert.match(result.output, /verified disk image is unavailable/);
    assert.equal(result.installed, 'installed');
    assert.equal(result.personal, 'legacy');
    assert.doesNotMatch(result.trace, /^mount 0 |^copy 0 /m);
  }
});

test('unavailable Node still blocks replacement before mounting or requesting authorization', t => {
  const result = install(t, 'no-node');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Install a compatible arm64 Node\.js/);
  assert.equal(result.installed, 'installed');
  assert.equal(result.personal, 'legacy');
  assert.equal(result.trace, '');
});
