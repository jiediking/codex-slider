#!/usr/bin/env python3
"""Build the native application with external Node dependency. Never publishes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    'app.mjs',
    'src/automatic.mjs',
    'src/compatibility-signed.json', 'src/compatibility-updates.json', 'src/compatibility.json',
    'src/compatibility.mjs', 'src/controller.mjs', 'src/core.mjs', 'src/native.mjs',
    'src/native_hook.mjs', 'src/consumer.mjs', 'src/rpc.mjs', 'src/server.mjs',
    'web/app.js', 'web/index.html', 'web/style.css',
)


def copy_runtime(source, destination):
    """Only explicit runtime files enter a release; new source files stay out by default."""
    for name in RUNTIME_FILES:
        file = source / name
        if file.is_symlink() or not file.is_file():
            raise RuntimeError('Missing or symbolic runtime file: ' + name)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, target)


def prepare_permissions(bundle):
    """Release files must be readable by users with a different local UID."""
    bundle.chmod(0o755)
    executable = bundle / 'Contents/MacOS/CodexSlider'
    for file in bundle.rglob('*'):
        file.chmod(0o755 if file.is_dir() or file == executable else 0o644)


def run(arguments):
    result = subprocess.run([str(item) for item in arguments], capture_output=True, text=True, umask=0o022)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--arch', choices=['arm64', 'x64'], default='arm64')
    parser.add_argument('--cache', type=Path, help='Legacy option; no runtime is downloaded or bundled')
    parser.add_argument('--output', type=Path, default=ROOT / 'dist-app')
    parser.add_argument('--work', type=Path, default=ROOT / '.build/macos')
    parser.add_argument('--compatibility-config', type=Path, help='Signed-list channel and Ed25519 public key JSON; never a private key')
    parser.add_argument('--compatibility-seed', type=Path, help='Signed bootstrap list matching the configured public key')
    options = parser.parse_args()
    for folder in [options.output, options.work]:
        folder.mkdir(parents=True, exist_ok=True)
    options.output = options.output.resolve()
    options.work = options.work.resolve()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    architecture = 'arm64' if options.arch == 'arm64' else 'x86_64'
    with tempfile.TemporaryDirectory(prefix='codex-slider-app-', dir=options.work) as temporary:
        stage = Path(temporary)
        bundle = stage / 'Codex Slider.app'
        contents = bundle / 'Contents'
        resources = contents / 'Resources'
        executable = contents / 'MacOS/CodexSlider'
        executable.parent.mkdir(parents=True)
        (resources / 'app').mkdir(parents=True)
        copy_runtime(ROOT, resources / 'app')
        license_file = ROOT / 'LICENSE'
        if license_file.is_symlink() or not license_file.is_file():
            raise RuntimeError('Missing or symbolic project license.')
        shutil.copy2(license_file, resources / 'LICENSE')
        if options.compatibility_config:
            config = json.loads(options.compatibility_config.read_text())
            if not {'url','publicKey'}.issubset(config) or set(config) - {'url','publicKey','localFile'}:
                raise RuntimeError('Compatibility config may contain only url, publicKey and localFile.')
            (resources / 'app/src/compatibility-updates.json').write_text(json.dumps(config, indent=2) + '\n')
        if options.compatibility_seed:
            shutil.copy2(options.compatibility_seed, resources / 'app/src/compatibility-signed.json')
        run(['/usr/bin/xcrun', 'swiftc', '-O', '-swift-version', '5', '-target', architecture + '-apple-macos15.0',
             '-module-cache-path', options.work / 'module-cache', ROOT / 'macos/NodeRuntime.swift',
             ROOT / 'macos/HostPolicy.swift', ROOT / 'macos/main.swift', '-o', executable])
        selected = json.loads(run([executable, '--check-node']))
        node = selected['path']
        run([node, '--input-type=module', '-e',
             'import fs from "node:fs"; import {validUpdateConfig,verifyEnvelope} from ' +
             json.dumps((resources / 'app/src/compatibility.mjs').as_uri()) + ';' +
             'const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!validUpdateConfig(c))process.exit(1);' +
             'verifyEnvelope(JSON.parse(fs.readFileSync(process.argv[2],"utf8")),c.publicKey);',
             resources / 'app/src/compatibility-updates.json', resources / 'app/src/compatibility-signed.json'])
        icon_png = stage / 'icon.png'
        icon_tool = stage / 'draw-icon'
        run(['/usr/bin/xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', options.work / 'module-cache', ROOT / 'macos/draw_icon.swift', '-o', icon_tool])
        run([icon_tool, icon_png])
        iconset = stage / 'AppIcon.iconset'
        iconset.mkdir()
        for size in [16, 32, 128, 256, 512]:
            for scale in [1, 2]:
                suffix = '@2x' if scale == 2 else ''
                run(['/usr/bin/sips', '-z', size * scale, size * scale, icon_png, '--out', iconset / f'icon_{size}x{size}{suffix}.png'])
        run(['/usr/bin/iconutil', '-c', 'icns', iconset, '-o', resources / 'AppIcon.icns'])
        info = {'CFBundleIdentifier': 'dev.codexslider.app', 'CFBundleName': 'Codex Slider', 'CFBundleDisplayName': 'Codex Slider',
                'CFBundleExecutable': 'CodexSlider', 'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version,
                'CFBundleVersion': '18', 'CFBundleIconFile': 'AppIcon', 'CFBundleDevelopmentRegion': 'en', 'CFBundleLocalizations': ['en'],
                'LSMinimumSystemVersion': '15.0', 'NSHighResolutionCapable': True,
                'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
                'NSHumanReadableCopyright': 'Codex Slider contributors. Not affiliated with OpenAI.'}
        (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
        prepare_permissions(bundle)
        run(['/usr/bin/codesign', '--force', '--sign', '-', '--options', 'runtime', bundle])
        run(['/usr/bin/codesign', '--verify', '--deep', '--strict', bundle])
        run(['/usr/bin/plutil', '-lint', contents / 'Info.plist'])
        # The disk image contains exactly the App and the conventional Applications link.
        image_root = stage / 'image'
        image_root.mkdir()
        image_root.chmod(0o755)
        shutil.move(str(bundle), image_root / bundle.name)
        os.symlink('/Applications', image_root / 'Applications')
        destination = options.output / f'Codex-Slider-{version}-macOS-{options.arch}.dmg'
        destination.unlink(missing_ok=True)
        run(['/usr/bin/hdiutil', 'create', '-volname', 'Codex Slider', '-srcfolder', image_root, '-format', 'UDZO', '-ov', destination])
        run(['/usr/bin/hdiutil', 'verify', destination])
        installed = options.output / bundle.name
        if installed.exists():
            shutil.rmtree(installed)
        shutil.copytree(image_root / bundle.name, installed)
    sha = hashlib.sha256(destination.read_bytes()).hexdigest()
    (options.output / 'SHA256SUMS.txt').write_text(f'{sha}  {destination.name}\n')
    report = {'app': str(installed), 'dmg': str(destination), 'version': version, 'architecture': options.arch,
              'sizeBytes': destination.stat().st_size, 'sha256': sha,
              'runtime': {'bundled': False, 'dependency': 'Node.js', 'range': '>=22.22.3 <23 || >=24.0.0 <25 || >=26.0.0 <27', 'architecture': options.arch},
              'signing': 'ad-hoc local development only', 'notarized': False, 'published': False}
    (options.work / 'build-result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
