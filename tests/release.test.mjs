import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {REPOSITORY, identity, sha256, makeCandidate, verifyCandidate, verifyRun, publicationGate, updateReadme, runRelease} from '../scripts/release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const template = fs.readFileSync(path.join(root, 'scripts/install_macos.sh'), 'utf8');
const sourceSha = 'a'.repeat(40);
const base = {repository: REPOSITORY, sourceSha, version: '0.6.6', buildRunId: '201', candidateRunId: '301'};
const dmg = identity(base);
const bytes = Buffer.from('Synthetic DMG fixture; never install this file.');
const hash = sha256(bytes);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slider-release-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const input = path.join(dir, 'build');
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, dmg), bytes);
  fs.writeFileSync(path.join(input, 'SHA256SUMS.txt'), `${hash}  ${dmg}\n`);
  const output = path.join(dir, 'candidate');
  const meta = makeCandidate(input, output, template, base);
  return {dir, input, output, meta};
}
const successfulRun = (workflow, id) => ({id, repository: {full_name: REPOSITORY}, head_repository: {full_name: REPOSITORY}, path: `.github/workflows/${workflow}`, head_branch: 'main', head_sha: sourceSha, status: 'completed', conclusion: 'success', event: 'workflow_dispatch'});

test('candidate preserves exact build bytes, pins installer, and verifies checksums', t => {
  const f = fixture(t);
  assert.deepEqual(verifyCandidate(f.output, template, base), f.meta);
  assert.deepEqual(fs.readFileSync(path.join(f.output, dmg)), bytes);
  const installer = fs.readFileSync(path.join(f.output, 'install.sh'), 'utf8');
  assert(installer.includes(`PACKAGE_SHA256='${hash}'`));
  assert(installer.includes(`/releases/download/v0.6.6/${dmg}`));
  assert(!/@[A-Z_]+@/.test(installer));
  execFileSync('bash', ['-n', path.join(f.output, 'install.sh')]);
  assert.throws(() => makeCandidate(f.input, f.output, template, base), /EEXIST/);
});

test('candidate rejects damaged input, altered files, extra files and source mismatch', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.input, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  ${dmg}\n`);
  assert.throws(() => makeCandidate(f.input, path.join(f.dir, 'bad'), template, base), /Build checksum mismatch/);
  assert.throws(() => verifyCandidate(f.output, template, {...base, sourceSha: 'b'.repeat(40)}), /sourceSha mismatch/);
  fs.appendFileSync(path.join(f.output, dmg), 'tamper');
  assert.throws(() => verifyCandidate(f.output, template, base), /checksum mismatch/);
  fs.writeFileSync(path.join(f.output, dmg), bytes);
  fs.writeFileSync(path.join(f.output, 'unexpected.txt'), 'extra');
  assert.throws(() => verifyCandidate(f.output, template, base), /Unexpected candidate files/);
});

test('candidate validation regenerates installer pins instead of trusting its claimed hash', t => {
  const f = fixture(t);
  const altered = fs.readFileSync(path.join(f.output, 'install.sh'), 'utf8').replace('github.com/', 'example.com/');
  fs.writeFileSync(path.join(f.output, 'install.sh'), altered);
  f.meta.files['install.sh'] = sha256(altered);
  fs.writeFileSync(path.join(f.output, 'candidate.json'), JSON.stringify(f.meta));
  assert.throws(() => verifyCandidate(f.output, template, base), /Installer pins mismatch/);
});

test('release provenance rejects fork, branch, failed run, wrong workflow and unsafe inputs', () => {
  const valid = successfulRun('build-macos.yml', 201);
  verifyRun(valid, 'build-macos.yml', sourceSha);
  for (const patch of [{head_repository: {full_name: 'other/repo'}}, {head_branch: 'topic'}, {conclusion: 'failure'}, {path: '.github/workflows/other.yml'}, {head_sha: 'b'.repeat(40)}, {event: 'pull_request'}]) {
    assert.throws(() => verifyRun({...valid, ...patch}, 'build-macos.yml', sourceSha));
  }
  for (const patch of [{version: "0.6.7'; touch /tmp/no"}, {buildRunId: '201;bad'}, {repository: 'other/repo'}, {sourceSha: '../main'}]) assert.throws(() => identity({...base, ...patch}));
});

test('publication requires explicit acceptance, exact tested hash and an unused version', t => {
  const {meta} = fixture(t);
  const accepted = {confirmation: 'true', testedHash: hash, existingRelease: null, existingTag: null};
  publicationGate(meta, accepted);
  for (const patch of [{confirmation: 'false'}, {confirmation: undefined}, {testedHash: ''}, {testedHash: '0'.repeat(64)}, {existingRelease: {tag_name: 'v0.6.6'}}, {existingTag: {ref: 'refs/tags/v0.6.6'}}]) assert.throws(() => publicationGate(meta, {...accepted, ...patch}));
});

test('stable README update changes only the download line and refuses an unfamiliar format', () => {
  const before = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const next = before.includes('[Download 0.6.7]') ? '0.6.8' : '0.6.7';
  const after = updateReadme(before, next);
  assert.equal(before.split('\n').filter((line, i) => line !== after.split('\n')[i]).length, 1);
  assert(after.includes(`releases/download/v${next}/Codex-Slider-${next}-macOS-arm64.dmg`));
  assert.throws(() => updateReadme(before.replace(/\[Download [0-9.]+\]/, '[Get it]'), next));
});

// Fake command transport exercises orchestration without GitHub writes or App execution.
function harness(t, options = {}) {
  const f = fixture(t);
  const checkout = path.join(f.dir, 'checkout');
  fs.mkdirSync(path.join(checkout, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(checkout, 'scripts/install_macos.sh'), template);
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({version: base.version}));
  fs.copyFileSync(path.join(root, 'README.md'), path.join(checkout, 'README.md'));
  const temp = path.join(f.dir, 'runner'); fs.mkdirSync(temp);
  const env = {GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sourceSha, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '401', RUNNER_TEMP: temp, BUILD_RUN_ID: '201', CANDIDATE_RUN_ID: '301', REAL_MAC_PASSED: 'true', TESTED_SHA256: hash};
  const calls = [];
  const missing = () => { throw Object.assign(new Error('Not Found'), {stderr: 'gh: Not Found (HTTP 404)'}); };
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') {
      if (options.pushFailure && args.includes('push')) throw new Error('Push rejected');
      return args[0] === 'rev-parse' ? sourceSha + '\n' : '';
    }
    if (cmd === 'bash' || cmd === 'npm') return '';
    if (cmd === 'curl') {
      if (options.publicFailure) throw new Error('Public download failed');
      const target = args[args.indexOf('--output') + 1];
      const name = path.basename(target);
      fs.copyFileSync(path.join(name.startsWith('live-') ? checkout : f.output, name.replace(/^live-/, '')), target);
      return '';
    }
    assert.equal(cmd, 'gh');
    if (args[0] === 'api') {
      const endpoint = args[1].replace(`repos/${REPOSITORY}/`, '');
      if (endpoint === 'git/ref/heads/main') return JSON.stringify({object: {sha: options.changedMain ? 'b'.repeat(40) : sourceSha}});
      if (endpoint === 'actions/runs/201') return JSON.stringify(successfulRun('build-macos.yml', 201));
      if (endpoint === 'actions/runs/301') return JSON.stringify(successfulRun('release.yml', 301));
      if (endpoint.startsWith('actions/workflows/ci.yml/runs?')) return JSON.stringify({workflow_runs: options.failedCI ? [] : [successfulRun('ci.yml', 202)]});
      if (endpoint.includes('/artifacts?')) return JSON.stringify({artifacts: [{name: endpoint.includes('/201/') ? `ci-macos-arm64-${sourceSha}` : 'candidate-301', expired: !!options.expired}]});
      if (endpoint.startsWith('releases/tags/') || endpoint.startsWith('git/ref/tags/')) {
        if (options.apiFailure) throw Object.assign(new Error('API unavailable'), {stderr: 'gh: server error (HTTP 500)'});
        return options.existing ? JSON.stringify({id: 1}) : missing();
      }
      assert.fail(`Unexpected API: ${endpoint}`);
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const target = args[args.indexOf('--dir') + 1];
      fs.cpSync(args[2] === '201' ? f.input : f.output, target, {recursive: true});
      return '';
    }
    if (args[0] === 'release') {
      if (args[1] === 'download') {
        const target = args[args.indexOf('--dir') + 1];
        for (const name of Object.keys(f.meta.files)) fs.copyFileSync(path.join(f.output, name), path.join(target, name));
        if (options.corruptDraft) fs.appendFileSync(path.join(target, dmg), 'corrupt');
      }
      return '';
    }
    assert.fail(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
  return {...f, root: checkout, env, run, calls, log: () => {}};
}
const writes = calls => calls.filter(c => (c[0] === 'gh' && c[1] === 'release' && ['create', 'edit'].includes(c[2])) || (c[0] === 'git' && c.includes('push')));

test('prepare orchestration is read-only, requires passing CI, and produces a reusable candidate', t => {
  const f = harness(t);
  const meta = runRelease('prepare', f);
  assert.equal(meta.candidateRunId, '401');
  assert.equal(meta.files[dmg], hash);
  assert.equal(writes(f.calls).length, 0);
  for (const options of [{changedMain: true}, {failedCI: true}, {expired: true}]) {
    const bad = harness(t, options);
    assert.throws(() => runRelease('prepare', bad));
    assert.equal(writes(bad.calls).length, 0);
  }
});

test('publish orchestration performs no writes for missing confirmation, mismatched test, existing version or API failure', t => {
  for (const options of [{}, {existing: true}, {apiFailure: true}]) {
    const f = harness(t, options);
    if (Object.keys(options).length === 0) f.env.TESTED_SHA256 = '0'.repeat(64);
    assert.throws(() => runRelease('publish', f));
    assert.equal(writes(f.calls).length, 0);
  }
  const f = harness(t);
  f.env.REAL_MAC_PASSED = 'false';
  assert.throws(() => runRelease('publish', f), /confirmation required/);
  assert.equal(f.calls.length, 0);
});

test('accepted publish stages verified assets before publication and updates the stable entry last (mock transport)', t => {
  const f = harness(t);
  runRelease('publish', f);
  const commands = writes(f.calls);
  assert.equal(commands.length, 3);
  assert(commands[0].includes('--draft'));
  assert(commands[0].includes(sourceSha));
  assert(commands[1].includes('--draft=false'));
  assert(commands[2].includes('HEAD:main'));
  assert.equal(fs.readFileSync(path.join(f.root, 'install.sh'), 'utf8'), fs.readFileSync(path.join(f.output, 'install.sh'), 'utf8'));
});

test('damaged draft stays unpublished; failed public verification or push never reports completion (mock transport)', t => {
  for (const options of [{corruptDraft: true}, {publicFailure: true}, {pushFailure: true}]) {
    const f = harness(t, options);
    const logs = [];
    assert.throws(() => runRelease('publish', {...f, log: line => logs.push(line)}));
    assert(logs.some(line => line.includes('may be partial')));
    assert(!logs.some(line => line.startsWith('### Published')));
    if (options.corruptDraft) assert(!writes(f.calls).some(c => c.includes('--draft=false')));
    if (options.publicFailure) assert(!writes(f.calls).some(c => c.includes('push')));
  }
});
