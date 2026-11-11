#!/usr/bin/env python3
"""Verify a CI package without launching the application or Codex."""
import hashlib
import json
import plistlib
from pathlib import Path
import subprocess
import sys
from build_macos import ROOT, RUNTIME_FILES

out = Path(sys.argv[1])
app = out / 'Codex Slider.app'
version = json.loads((ROOT / 'package.json').read_text())['version']
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'dev.codexslider.app'
assert info['CFBundleShortVersionString'] == version
exe = app / 'Contents/MacOS/CodexSlider'
arch = subprocess.check_output(['/usr/bin/lipo', '-archs', str(exe)], text=True).strip()
assert arch == 'arm64', arch
runtime = app / 'Contents/Resources/app'
assert {str(p.relative_to(runtime)) for p in runtime.rglob('*') if p.is_file()} == set(RUNTIME_FILES)
assert (app / 'Contents/Resources/LICENSE').read_bytes() == (ROOT / 'LICENSE').read_bytes()
for p in [app, *app.rglob('*')]:
    assert not p.is_symlink(), p
    assert p.stat().st_mode & 0o777 == (0o755 if p.is_dir() or p == exe else 0o644), p
subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
dmg = out / f'Codex-Slider-{version}-macOS-arm64.dmg'
subprocess.run(['/usr/bin/hdiutil', 'verify', str(dmg)], check=True, stdout=subprocess.DEVNULL)
expected = f'{hashlib.sha256(dmg.read_bytes()).hexdigest()}  {dmg.name}\n'
assert (out / 'SHA256SUMS.txt').read_text() == expected
print('App identity, arm64 architecture, runtime allowlist, permissions, local signature, DMG and SHA256 verified.')
