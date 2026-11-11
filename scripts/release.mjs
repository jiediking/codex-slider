// Manual promotion of an existing CI package. Never builds or launches the App.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const REPOSITORY = 'jiediking/codex-slider';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[1-9][0-9]{0,19}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const command = (cmd, args, cwd) => execFileSync(cmd, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

export function identity(meta) {
  assert.equal(meta.repository, REPOSITORY, 'Unexpected repository');
  assert.match(meta.sourceSha, SHA, 'Invalid source commit');
  assert.match(meta.version, VERSION, 'Invalid version');
  assert.match(meta.buildRunId, ID, 'Invalid build run ID');
  assert.match(meta.candidateRunId, ID, 'Invalid candidate run ID');
  return `Codex-Slider-${meta.version}-macOS-arm64.dmg`;
}

export function renderInstaller(template, meta, dmgHash) {
  const dmg = identity(meta);
  assert.match(dmgHash, HASH, 'Invalid DMG checksum');
  const pins = {
    PACKAGE_URL: `https://github.com/${REPOSITORY}/releases/download/v${meta.version}/${dmg}`,
    PACKAGE_SHA256: dmgHash, APP_FILENAME: 'Codex Slider.app', APP_VERSION: meta.version,
  };
  for (const [key, value] of Object.entries(pins)) {
    assert.equal(template.split(`@${key}@`).length, 2, `Missing or repeated installer pin: ${key}`);
    template = template.replace(`@${key}@`, value);
  }
  assert(!/@[A-Z_]+@/.test(template), 'Unfilled installer pin');
  return template;
}

export function testingNotes(meta) {
  const dmg = identity(meta);
  return `# Candidate ${meta.candidateRunId}\n\nNot an official release. Source: ${meta.sourceSha}\n\nDMG SHA256: ${meta.files[dmg]}\n\nOn the current Mac or another Mac, extract this artifact, open Terminal in its folder, and run:\n\n\`\`\`sh\n/usr/bin/shasum -a 256 -c SHA256SUMS.txt\nCODEX_SLIDER_PACKAGE_FILE="$PWD/${dmg}" /bin/bash ./install.sh\n\`\`\`\n\nQuit Slider before installation. The installer does not launch or quit Codex.\nSave your work first: the full launch test requires quitting Codex normally.\n\n- Check installation/upgrade and preservation of saved presets.\n- Launch through Slider; check preset order, model and reasoning at every position.\n- Confirm the entire Slider App exits after success and Codex remains usable.\n- Reopen Slider and check that saved presets can be used again.\n\nReport this candidate ID, DMG SHA256 and results. Publication requires a separate confirmation.\n`;
}

export function makeCandidate(input, output, template, meta) {
  const dmg = identity(meta);
  assert.deepEqual(fs.readdirSync(input).sort(), [dmg, 'SHA256SUMS.txt'].sort(), 'Unexpected build files');
  for (const name of [dmg, 'SHA256SUMS.txt']) assert(fs.lstatSync(path.join(input, name)).isFile(), 'Build must contain regular files');
  const bytes = fs.readFileSync(path.join(input, dmg));
  const hash = sha256(bytes);
  assert.equal(read(path.join(input, 'SHA256SUMS.txt')), `${hash}  ${dmg}\n`, 'Build checksum mismatch');
  fs.mkdirSync(output); // Never reuse a previous candidate directory.
  fs.writeFileSync(path.join(output, dmg), bytes);
  const installer = renderInstaller(template, meta, hash);
  fs.writeFileSync(path.join(output, 'install.sh'), installer);
  const sums = `${hash}  ${dmg}\n${sha256(installer)}  install.sh\n`;
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), sums);
  const result = {...meta, schemaVersion: 1, files: {
    [dmg]: hash, 'install.sh': sha256(installer), 'SHA256SUMS.txt': sha256(sums),
  }};
  fs.writeFileSync(path.join(output, 'candidate.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'TESTING.md'), testingNotes(result));
  return result;
}

export function verifyCandidate(dir, template, expected) {
  const meta = json(path.join(dir, 'candidate.json'));
  const dmg = identity(meta);
  assert.equal(meta.schemaVersion, 1, 'Unsupported candidate schema');
  for (const [key, value] of Object.entries(expected)) assert.equal(meta[key], value, `Candidate ${key} mismatch`);
  const assets = [dmg, 'install.sh', 'SHA256SUMS.txt'];
  assert.deepEqual(Object.keys(meta.files).sort(), [...assets].sort(), 'Unexpected candidate assets');
  assert.deepEqual(fs.readdirSync(dir).sort(), [...assets, 'candidate.json', 'TESTING.md'].sort(), 'Unexpected candidate files');
  for (const name of fs.readdirSync(dir)) assert(fs.lstatSync(path.join(dir, name)).isFile(), 'Candidate must contain regular files');
  for (const name of assets) {
    const file = path.join(dir, name);
    assert.match(meta.files[name], HASH);
    assert.equal(sha256(fs.readFileSync(file)), meta.files[name], `Candidate checksum mismatch: ${name}`);
  }
  assert.equal(read(path.join(dir, 'install.sh')), renderInstaller(template, meta, meta.files[dmg]), 'Installer pins mismatch');
  assert.equal(read(path.join(dir, 'SHA256SUMS.txt')), `${meta.files[dmg]}  ${dmg}\n${meta.files['install.sh']}  install.sh\n`);
  assert.equal(read(path.join(dir, 'TESTING.md')), testingNotes(meta));
  return meta;
}

export function verifyRun(run, workflow, sourceSha) {
  assert.equal(run.repository?.full_name, REPOSITORY, 'Wrong run repository');
  assert.equal(run.head_repository?.full_name, REPOSITORY, 'Fork builds cannot be released');
  assert.equal(run.path, `.github/workflows/${workflow}`, 'Unexpected workflow');
  assert.equal(run.head_branch, 'main', 'Run must use main');
  assert.equal(run.head_sha, sourceSha, 'Run source mismatch');
  assert.equal(run.status, 'completed', 'Run not completed');
  assert.equal(run.conclusion, 'success', 'Run did not pass');
  assert(['push', 'workflow_dispatch'].includes(run.event), 'Unexpected run event');
  if (workflow === 'release.yml') assert.equal(run.event, 'workflow_dispatch');
}

export function publicationGate(meta, {confirmation, testedHash, existingRelease, existingTag}) {
  const dmg = identity(meta);
  assert.equal(confirmation, 'true', 'Real-Mac acceptance and publication confirmation required');
  assert.match(testedHash, HASH, 'Tested DMG SHA256 required');
  assert.equal(testedHash, meta.files[dmg], 'Tested DMG does not match this candidate');
  assert(!existingRelease && !existingTag, 'Version already exists; public assets must never be overwritten');
}

export function downloadLinks(version) {
  assert.match(version, VERSION);
  const base = `https://github.com/${REPOSITORY}/releases`;
  return `[Download ${version}](${base}/tag/v${version}) · [DMG](${base}/download/v${version}/Codex-Slider-${version}-macOS-arm64.dmg) · [Checksums](${base}/download/v${version}/SHA256SUMS.txt)`;
}

export function updateReadme(text, version) {
  const matches = [...text.matchAll(/^\[Download ([0-9.]+)\].*$/gm)];
  assert.equal(matches.length, 1, 'Expected one README download line');
  assert.equal(matches[0][0], downloadLinks(matches[0][1]), 'Unexpected README download format');
  return text.replace(matches[0][0], downloadLinks(version));
}

export function runRelease(operation, {env = process.env, root = ROOT, run = command, log = console.log} = {}) {
  assert(['prepare', 'publish'].includes(operation), 'Select prepare or publish');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'Run this workflow in the source repository');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Dispatch this workflow on main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Manual dispatch required');
  assert.match(env.GITHUB_RUN_ID, ID);
  if (operation === 'publish') {
    assert.equal(env.REAL_MAC_PASSED, 'true', 'Real-Mac acceptance and publication confirmation required');
    assert.match(env.TESTED_SHA256, HASH, 'Tested DMG SHA256 required');
  }
  const invoke = (cmd, args) => run(cmd, args, root);
  const gh = args => invoke('gh', args);
  const api = endpoint => JSON.parse(gh(['api', `repos/${REPOSITORY}/${endpoint}`]));
  const optional = endpoint => {
    try { return api(endpoint); }
    catch (error) {
      if (/\(HTTP 404\)/.test(String(error.stderr))) return null;
      throw error; // Authentication, network and permission failures are not absence.
    }
  };
  const sourceSha = invoke('git', ['rev-parse', 'HEAD']).trim();
  assert.match(sourceSha, SHA);
  assert.equal(sourceSha, env.GITHUB_SHA, 'Checkout source mismatch');
  const current = () => assert.equal(api('git/ref/heads/main').object.sha, sourceSha, 'Main changed; prepare and test a new candidate');
  current();
  const version = json(path.join(root, 'package.json')).version;
  assert.match(version, VERSION);
  const template = read(path.join(root, 'scripts/install_macos.sh'));
  const work = path.join(env.RUNNER_TEMP, 'slider-release');
  fs.mkdirSync(work); // A rerun gets a fresh runner; never accept stale files.
  const dir = path.join(work, 'candidate');
  const checkBuild = id => {
    assert.match(id, ID);
    verifyRun(api(`actions/runs/${id}`), 'build-macos.yml', sourceSha);
    const runs = api(`actions/workflows/ci.yml/runs?head_sha=${sourceSha}&branch=main&per_page=100`).workflow_runs;
    assert(runs.some(check => {
      try { verifyRun(check, 'ci.yml', sourceSha); return true; } catch { return false; }
    }), 'No successful CI checks for this source');
  };
  const download = (id, name, target) => {
    const artifacts = api(`actions/runs/${id}/artifacts?per_page=100`).artifacts.filter(a => a.name === name && !a.expired);
    assert.equal(artifacts.length, 1, 'Expected exactly one available artifact');
    gh(['run', 'download', id, '--repo', REPOSITORY, '--name', name, '--dir', target]);
  };
  if (operation === 'prepare') {
    checkBuild(env.BUILD_RUN_ID);
    const input = path.join(work, 'build');
    download(env.BUILD_RUN_ID, `ci-macos-arm64-${sourceSha}`, input);
    const meta = makeCandidate(input, dir, template, {
      repository: REPOSITORY, sourceSha, version, buildRunId: env.BUILD_RUN_ID, candidateRunId: env.GITHUB_RUN_ID,
    });
    verifyCandidate(dir, template, {sourceSha, version});
    invoke('bash', ['-n', path.join(dir, 'install.sh')]);
    current();
    const summary = `### Candidate prepared; not published\n\nCandidate: ${meta.candidateRunId}\n\nSource: ${sourceSha}\n\nDMG SHA256: \`${meta.files[identity(meta)]}\`\n\nDownload the artifact and follow TESTING.md on the current Mac or another Mac. No tag, Release or stable installer was changed.\n`;
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    log(summary);
    return meta;
  }
  assert.match(env.CANDIDATE_RUN_ID, ID, 'Accepted candidate run ID required');
  verifyRun(api(`actions/runs/${env.CANDIDATE_RUN_ID}`), 'release.yml', sourceSha);
  download(env.CANDIDATE_RUN_ID, `candidate-${env.CANDIDATE_RUN_ID}`, dir);
  const meta = verifyCandidate(dir, template, {sourceSha, version, candidateRunId: env.CANDIDATE_RUN_ID});
  checkBuild(meta.buildRunId);
  const tag = `v${version}`;
  publicationGate(meta, {
    confirmation: env.REAL_MAC_PASSED, testedHash: env.TESTED_SHA256,
    existingRelease: optional(`releases/tags/${tag}`), existingTag: optional(`git/ref/tags/${tag}`),
  });
  assert.equal(invoke('git', ['status', '--porcelain']).trim(), '', 'Release checkout must be clean');
  invoke('bash', ['-n', path.join(dir, 'install.sh')]);
  const readme = updateReadme(read(path.join(root, 'README.md')), version);
  const assets = Object.keys(meta.files);
  const verifyAssets = (location, isPublic) => {
    fs.mkdirSync(location);
    if (isPublic) {
      for (const name of assets) invoke('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '120', `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`, '--output', path.join(location, name)]);
    } else gh(['release', 'download', tag, '--repo', REPOSITORY, '--dir', location]);
    assert.deepEqual(fs.readdirSync(location).sort(), [...assets].sort(), 'Uploaded asset set mismatch');
    for (const name of assets) assert.equal(sha256(fs.readFileSync(path.join(location, name))), meta.files[name], `Uploaded asset mismatch: ${name}`);
  };
  current();
  let releaseWritten = false;
  try {
    // --draft is essential: CLI defaults must not publish before asset verification.
    gh(['release', 'create', tag, '--repo', REPOSITORY, '--target', sourceSha, '--draft', '--title', `Codex Slider ${version}`,
      '--notes', `Apple Silicon macOS package. Requires macOS 15+ and a supported external Node.js runtime.\n\nReal-Mac accepted candidate: ${meta.candidateRunId}. Source: ${sourceSha}.`,
      ...assets.map(name => path.join(dir, name))]);
    releaseWritten = true;
    verifyAssets(path.join(work, 'draft-check'), false);
    current();
    gh(['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--latest']);
    verifyAssets(path.join(work, 'public-check'), true);
    current();
    fs.copyFileSync(path.join(dir, 'install.sh'), path.join(root, 'install.sh'));
    fs.writeFileSync(path.join(root, 'README.md'), readme);
    invoke('npm', ['run', 'check']);
    invoke('git', ['diff', '--check']);
    invoke('git', ['-c', 'user.name=Codex Slider contributors', '-c', 'user.email=39128100+jiediking@users.noreply.github.com', 'commit', '--only', '-m', `release: point installer to ${version}`, '--', 'install.sh', 'README.md']);
    invoke('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', 'HEAD:main']);
    for (const name of ['install.sh', 'README.md']) {
      const downloaded = path.join(work, `live-${name}`);
      invoke('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '120', `https://raw.githubusercontent.com/${REPOSITORY}/main/${name}`, '--output', downloaded]);
      assert.equal(sha256(fs.readFileSync(downloaded)), sha256(fs.readFileSync(path.join(root, name))), `Stable entry mismatch: ${name}`);
    }
  } catch (error) {
    if (releaseWritten) log('Release preparation started; publication or stable-entry update may be partial. Inspect the Release and main. Repair only missing steps using the same accepted candidate; do not rebuild or overwrite assets.');
    throw error;
  }
  const summary = `### Published ${tag}\n\nhttps://github.com/${REPOSITORY}/releases/tag/${tag}\n\nThe accepted assets and stable installer were verified.\n`;
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  log(summary);
  return meta;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runRelease(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
