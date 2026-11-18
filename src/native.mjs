import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {nativePresetAction} from './native_hook.mjs';
import {SliderError, atomicJSON} from './core.mjs';
import {ADAPTER_VERSION, validAssetPath} from './compatibility.mjs';
import {verifyOfficialInstallation, requireOfficialInstallation, inspectAutomatic,applyAutomaticProof,saveAutomaticProof} from './automatic.mjs';
import {observeSliderConsumer,validateConsumerObservation} from './consumer.mjs';

const runFile = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function installationStamp(app) {
  try {
    const stats=await Promise.all(['Info.plist','Resources/app.asar',`MacOS/${path.basename(app.executable)}`].map(
      name=>fs.stat(path.join(app.appPath,'Contents',name))));
    return JSON.stringify(stats.map(s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]));
  } catch {return null;}
}

async function readExactly(handle, size, offset) {
  const buffer = Buffer.alloc(size);
  let total = 0;
  while (total < size) {
    const {bytesRead} = await handle.read(buffer, total, size - total, offset + total);
    if (!bytesRead) throw new Error('Unexpected end of application archive.');
    total += bytesRead;
  }
  return buffer;
}

export async function rendererHash(archivePath, reviewed = null) {
  const handle = await fs.open(archivePath, 'r');
  try {
    const prefix = await readExactly(handle, 16, 0);
    const length = prefix.readUInt32LE(12);
    if (!length || length > 16 * 1024 * 1024) throw new Error('Invalid application archive.');
    const header = JSON.parse((await readExactly(handle, length, 16)).toString('utf8'));
    if (reviewed?.assets) {
      const fingerprints = [];
      let total = 0;
      for (const asset of [...reviewed.assets].sort((a, b) => a.path.localeCompare(b.path))) {
        if (!validAssetPath(asset.path)) throw new Error('Invalid renderer path.');
        let entry = header;
        for (const part of asset.path.split('/')) entry = entry?.files?.[part];
        const offset = Number(entry?.offset);
        if (!entry || entry.unpacked || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > 64 * 1024 * 1024 ||
            !Number.isSafeInteger(offset) || offset < 0 || (total += entry.size) > 256 * 1024 * 1024) throw new Error('Invalid renderer asset.');
        const bytes = await readExactly(handle, entry.size, 8 + prefix.readUInt32LE(4) + offset);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digest !== asset.sha256) throw new Error('Renderer fingerprint mismatch.');
        fingerprints.push({path: asset.path, sha256: digest});
      }
      if (!fingerprints.length) throw new Error('Missing renderer fingerprints.');
      return crypto.createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex');
    }
    const assets = header.files?.webview?.files?.assets?.files;
    const name = Object.keys(assets ?? {}).find(value => /^app-initial-.*\.js$/.test(value));
    const entry = assets?.[name];
    if (!entry || entry.unpacked || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > 64 * 1024 * 1024) throw new Error('Invalid renderer asset.');
    const offset = Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid renderer offset.');
    const buffer = await readExactly(handle, entry.size, 8 + prefix.readUInt32LE(4) + offset);
    if (!buffer.includes(Buffer.from('423260384'))) throw new Error('Expected slider configuration was not found.');
    return crypto.createHash('sha256').update(buffer).digest('hex');
  } finally { await handle.close(); }
}

export async function inspectApp(appOverride, compatibility = null, candidatePaths = null) {
  const candidates = appOverride ? [path.resolve(appOverride)] : candidatePaths ?? [
    '/Applications/ChatGPT.app', '/Applications/Codex.app',
    path.join(os.homedir(), 'Applications', 'ChatGPT.app'), path.join(os.homedir(), 'Applications', 'Codex.app')
  ];
  const manifest = compatibility ?? JSON.parse(await fs.readFile(path.join(root, 'compatibility.json'), 'utf8'));
  const installations = [], failures = [];
  for (const appPath of candidates) {
    if (!await exists(path.join(appPath, 'Contents', 'Info.plist'))) continue;
    try {
      const plist = path.join(appPath, 'Contents', 'Info.plist');
      const field = async name => (await runFile('/usr/libexec/PlistBuddy', ['-c', 'Print :' + name, plist])).stdout.trim();
      if (await field('CFBundleIdentifier') !== manifest.bundleId) continue;
      const version = await field('CFBundleShortVersionString');
      const build = await field('CFBundleVersion');
      const executableName = await field('CFBundleExecutable');
      if (!executableName || path.basename(executableName) !== executableName) continue;
      const executable = path.join(appPath, 'Contents', 'MacOS', executableName);
      const cli = path.join(appPath, 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
      const reviewed = manifest.builds.find(value => value.version === version && value.build === build);
      let compatible = false;
      let fingerprint = null;
      const upgradeRequired = Boolean(reviewed && reviewed.adapterVersion > ADAPTER_VERSION);
      if (reviewed && !upgradeRequired && reviewed.adapterVersion >= 1 && reviewed.adapterVersion <= ADAPTER_VERSION) {
        try {
          fingerprint = await rendererHash(path.join(appPath, 'Contents', 'Resources', 'app.asar'), reviewed);
          compatible = reviewed.assets ? true : fingerprint === reviewed.rendererSha256;
        } catch { /* Keep model discovery available when fingerprints differ. */ }
      }
      installations.push({found: true, appPath, executable, cli: await exists(cli) ? cli : null, version, build, compatible,
        upgradeRequired, compatibilityReason:compatible ? 'supported':upgradeRequired ? 'adapter-upgrade':reviewed ? 'resources-changed':'unlisted',
        rendererSha256: compatible ? fingerprint : null});
    } catch {
      failures.push({found: true, appPath, compatible: false, cli: null, error: 'Codex could not be checked. Reinstall the official app or select a supported version.'});
    }
  }
  // Check the newest installed Codex, including an unreviewed update. Never silently
  // fall back to an older supported copy or let an old legacy name win by path order.
  installations.sort((a,b) => b.version.localeCompare(a.version,'en',{numeric:true}) ||
    b.build.localeCompare(a.build,'en',{numeric:true}));
  if (!installations.length) return failures[0] ?? {found: false, compatible: false, cli: null};
  return {...installations[0], installations:installations.map(({appPath,version,build,compatible})=>({appPath,version,build,compatible}))};
}

export async function processIDs(executable) {
  if (!executable) return [];
  const {stdout} = await runFile('/bin/ps', ['-axo', 'pid=,comm=']);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

export async function launchApplication(app, args, {
  run = runFile, readPIDs = processIDs, pause = sleep, attempts = 100
} = {}) {
  // A detached POSIX child still inherits the launching App's macOS coalition.
  // LaunchServices gives Codex its own application lifecycle instead.
  try {
    await run('/usr/bin/open', ['-a', app.appPath, ...(args.length ? ['--args', ...args] : [])], {timeout:10000});
  } catch {
    throw new SliderError('LAUNCH_FAILED', 'macOS could not open Codex. Your saved presets are kept.', 409);
  }
  // open's PID belongs to the short-lived system launcher, not the application.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pids = await readPIDs(app.executable);
    if (pids.length === 1) return pids[0];
    if (pids.length > 1) break;
    if (attempt + 1 < attempts) await pause(100);
  }
  throw new SliderError('LAUNCH_FAILED', 'A single Codex process could not be confirmed. Codex may have opened; quit it normally before trying again. Your saved presets are kept.', 409);
}

export function validDebugURL(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && url.hostname === '127.0.0.1' && Number(url.port) === port && !url.username && !url.password;
  } catch { return false; }
}

async function rendererPages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(1500), redirect: 'error'});
  if (!response.ok) throw new Error('The local debugging endpoint is not ready.');
  const body = await response.text();
  if (body.length > 1024 * 1024) throw new Error('Unexpected debugging response.');
  const targets = JSON.parse(body);
  if (!Array.isArray(targets)) throw new Error('Unexpected debugging response.');
  return targets.filter(target => target.type === 'page' && typeof target.id === 'string' && target.id.length>0 && target.id.length<=256 &&
    target.url?.startsWith('app://-/') && validDebugURL(target.webSocketDebuggerUrl, port));
}

async function evaluateRenderer(page, expression) {
  return new Promise((resolve, reject) => {
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      const timer = setTimeout(() => finish(new Error('The local debugging request timed out.')), 3000);
      let finished = false;
      function finish(error, value) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.close();
        error ? reject(error) : resolve(value);
      }
      socket.onerror = () => finish(new Error('Could not connect to the local debugging endpoint.'));
      socket.onopen = () => socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {
        expression, returnByValue: true
      }}));
      socket.onmessage = event => {
        try {
          if (event.data.length > 1024 * 1024) throw new Error('Unexpected debugging response.');
          const message = JSON.parse(event.data);
          if (message.id !== 1) return;
          if (message.error || message.result?.exceptionDetails) throw new Error('The slider adapter failed.');
          finish(null, message.result?.result?.value);
        } catch (error) { finish(error); }
      };
  });
}

export async function evaluateConsumer(port, rendererId = null) {
  const results=[];
  const pages=await rendererPages(port);
  const owned=rendererId===null?pages:pages.filter(page=>page.id===rendererId);
  if(rendererId!==null&&owned.length!==1)return {status:'pending',reason:'session-changed'};
  for(const page of owned) {
    results.push(await evaluateRenderer(page,'('+observeSliderConsumer.toString()+')()'));
  }
  const ready=results.filter(r=>r?.status==='ready');
  if(ready.length===1)return ready[0];
  return {status:'pending',reason:ready.length?'ambiguous-slider':results[0]?.reason??'open-model-menu'};
}

export async function evaluatePresets(port, payload) {
  const locate = `(${observeSliderConsumer.toString()})("locate")`;
  const pages = await rendererPages(port);
  const locations = await Promise.all(pages.map(async page => {
    try {
      const location = await evaluateRenderer(page, locate);
      return location?.status === 'located' && location.source === 'committed-model-picker' ? page : null;
    } catch { return null; }
  }));
  const candidates = locations.filter(Boolean);
  if (candidates.length !== 1) {
    return {installed: false, compatibility: 'pending', reason: candidates.length ? 'ambiguous-picker' : 'picker-not-ready'};
  }
  const page = candidates[0];
  // The page may navigate between locating the picker and applying its presets.
  const result = await evaluateRenderer(page, `(() => {
    if ((${locate}).status !== 'located') return {installed: false, compatibility: 'pending', reason: 'picker-not-ready'};
    const action = (${nativePresetAction.toString()});
    const probe = action(null, 'probe');
    return probe.supported ? action(${JSON.stringify(payload)}) : probe;
  })()`);
  if (result?.installed && JSON.stringify(result.presets) === JSON.stringify(payload.presets[0])) {
    return {...result, rendererId: page.id};
  }
  return result;
}

export class NativeBridge {
  constructor({appPath, directory = null, disableLaunch = false, adapters = {}, applyTimeout = 25000, compatibilityUpdates = null} = {}) {
    this.appPath = appPath;
    this.directory = directory;
    this.disableLaunch = disableLaunch;
    this.applyTimeout = applyTimeout;
    this.compatibilityUpdates = compatibilityUpdates;
    const openApplication = app => runFile('/usr/bin/open', ['-a', app.appPath]);
    this.adapters = {inspectApp, verifyOfficialInstallation, inspectAutomatic, processIDs, freePort, launchApplication,
      openApplication, evaluatePresets, evaluateConsumer, installationStamp, sleep, now:Date.now, ...adapters};
  }

  async inspect({refreshCompatibility = false, forceCompatibility = false} = {}) {
    let manifest = this.compatibilityUpdates ? await this.compatibilityUpdates.current({refresh:false}) : null;
    let app = await this.adapters.inspectApp(this.appPath, manifest);
    if (this.compatibilityUpdates && refreshCompatibility && !this.disableLaunch) {
      const before = manifest.builds.find(b => b.version === app.version && b.build === app.build);
      const updated = await this.compatibilityUpdates.current({refresh:true,force:forceCompatibility,
        unknownBuild:app.found && !before ? `${app.version}/${app.build}` : null});
      const after = updated.builds.find(b => b.version === app.version && b.build === app.build);
      if (JSON.stringify(before) !== JSON.stringify(after)) app = await this.adapters.inspectApp(this.appPath, updated);
      manifest = updated;
    }
    if (app.found) {
      const official = await this.adapters.verifyOfficialInstallation(app);
      if (official) {
        app = official;
        if (!app.compatible && !app.upgradeRequired) app = await this.adapters.inspectAutomatic(app);
      } else {
        app = {...app, identityVerified: false, compatible: false, upgradeRequired: false,
          rendererSha256: null, compatibilityReason: 'unverified-installation', automaticStatus: 'unverified-installation'};
      }
    }
    app = applyAutomaticProof(app,this.directory);
    return this.compatibilityUpdates ? {...app,compatibility:this.compatibilityUpdates.status?.()} : app;
  }
  running(app) { return this.adapters.processIDs(app?.executable); }

  async openStandard(app) {
    if (this.disableLaunch) throw new SliderError('LAUNCH_DISABLED', 'Launching Codex is disabled in this local test session.', 409);
    if (!app?.found || !app.appPath) throw new SliderError('APP_MISSING', 'Install the official Codex desktop app first.', 409);
    const checked = requireOfficialInstallation(await this.adapters.verifyOfficialInstallation(app));
    await this.adapters.openApplication(checked);
  }

  async verifySession() {
    const s=this.session;
    if(this.disableLaunch||!s)return {status:'verification-pending',applied:false,consumerVerified:false,verificationReason:'no-owned-session'};
    // The port is kept only in memory from this bridge's own consented launch.
    // Rechecking never attaches to an arbitrary existing Codex or a disk record.
    const checked=s.stamp?s.app:await this.inspect(),pids=await this.running(checked);
    const identity=a=>JSON.stringify([a.appPath,a.version,a.build,a.rendererSha256]);
    if(typeof s.rendererId!=='string'||!s.rendererId||identity(checked)!==identity(s.app)||(s.stamp&&await this.adapters.installationStamp(s.app)!==s.stamp)||pids.length!==1||pids[0]!==s.pid){
      this.session=null;
      return {...s.result,status:'verification-pending',applied:false,consumerVerified:false,uiVerified:false,
        consumerEvidence:undefined,verificationReason:'session-changed'};
    }
    if(s.result.status==='consumer-verified')return s.result;
    let value;
    try {value=await this.adapters.evaluateConsumer(s.port,s.rendererId);}
    catch {value={status:'pending',reason:'observer-unavailable'};}
    const observation=validateConsumerObservation(value,s.presets),now=this.adapters.now();
    if (observation.status !== 'matched') {
      s.stable = null;
      s.result = {...s.result, verificationReason: observation.status === 'mismatch' ? 'rendered-slider-mismatch' : observation.reason};
      return s.result;
    }
    if(s.stable?.fingerprint!==observation.fingerprint)s.stable={fingerprint:observation.fingerprint,since:now,count:1};
    else s.stable.count++;
    const settled=s.stable?.count>=2&&now-s.stable.since>=1000;
    if(settled){
      s.result={...s.result,status:'consumer-verified',applied:true,
        consumerVerified:true,uiVerified:true,inferenceVerified:false,
        verificationReason:'rendered-slider-matched',consumerEvidence:observation.evidence};
      saveAutomaticProof(s.app,this.directory,'consumer-verified',{presets:s.presets,observation:value});
      atomicJSON(s.file,{...s.record,...s.result,checkedAt:new Date().toISOString()});
    } else {
      s.result={...s.result,verificationReason:'waiting-for-stable-render'};
    }
    return s.result;
  }

  async launch({app, presets, directory, standard = false, consent = false, onPhase = () => {}}) {
    if (this.disableLaunch) throw new SliderError('LAUNCH_DISABLED', 'Launching Codex is disabled in this local test session.', 409);
    const checked = await this.inspect();
    if (!checked.found || !checked.executable) throw new SliderError('APP_MISSING', 'Install the official Codex desktop app first.', 409);
    requireOfficialInstallation(checked);
    const running = await this.running(checked);
    if (standard) {
      if (running.length) return {status: 'already-running', applied: false};
      onPhase('Opening Codex');
      await this.adapters.launchApplication(checked, []);
      return {status: 'standard-opened', applied: false};
    }
    if (!checked.compatible || checked.appPath !== app.appPath || checked.version !== app.version || checked.build !== app.build || checked.rendererSha256 !== app.rendererSha256) throw new SliderError('VERSION_UNSUPPORTED', 'Codex changed or could not be verified. Check compatibility again. Your presets are saved.', 409);
    if (!consent) throw new SliderError('CONSENT_REQUIRED', 'Enable the local debugging connection before using the custom slider.', 409);
    if (running.length) return {status: 'needs-quit', applied: false};
    this.session=null;
    const stamp=await this.adapters.installationStamp(checked);
    const port = await this.adapters.freePort();
    onPhase('Opening Codex');
    const pid = await this.adapters.launchApplication(checked, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port]);
    const record = {app: {version: checked.version, build: checked.build, rendererSha256: checked.rendererSha256},
      pid, port, startedAt: new Date().toISOString(), configurationInjected: false, consumerVerified:false,uiVerified: false, inferenceVerified: false};
    const file = path.join(directory, 'last-launch.json');
    let pendingReason;
    try {
      atomicJSON(file, record);
      onPhase(checked.requiresRuntimeCheck ? 'Checking your adapter' : 'Applying your slider');
      const deadline = Date.now() + this.applyTimeout;
      while (Date.now() < deadline) {
        let result;
        try { result = await this.adapters.evaluatePresets(port, {presets: [presets]}); }
        catch { result = null; }
        pendingReason = result?.reason;
        if (result?.compatibility === 'incompatible') {
          atomicJSON(file,{...record,status:'adapter-incompatible',verificationReason:pendingReason,
            error:'The current adapter does not match the ready configuration schema.'});
          throw new SliderError('ADAPTER_INCOMPATIBLE','Codex’s slider configuration has changed and needs an updated Slider adapter. Your presets are saved. Quit Codex normally to close the local debugging connection.',409);
        }
        if (result?.installed && result.readBackVerified === true && result.rendererId && JSON.stringify(result.presets) === JSON.stringify(presets)) {
          // The renderer action reads its own replacement getter. This confirms
          // configuration delivery, never that the actual slider consumed it.
          atomicJSON(file, {...record,status:'verification-pending',configurationInjected: true,
            readBackVerified:true,presets,configurationAppliedAt: new Date().toISOString()});
          saveAutomaticProof(checked,this.directory,'configuration-applied');
          const pendingResult={status:'verification-pending',applied:false,configurationApplied:true,
            readBackVerified:true,consumerVerified:false,uiVerified:false,inferenceVerified:false,
            verificationReason:'open-model-menu',presets};
          this.session={app:checked,pid,port,rendererId:result.rendererId,stamp,presets:JSON.parse(JSON.stringify(presets)),file,
            record:{...record,configurationInjected:true,readBackVerified:true},result:pendingResult,stable:null};
          return pendingResult;
        }
        await this.adapters.sleep(500);
      }
      atomicJSON(file, {...record, status:'apply-failed', verificationReason:pendingReason, error:'Presets could not be applied to this session.'});
    } catch (error) {
      if (error.code === 'ADAPTER_INCOMPATIBLE') throw error;
      throw new SliderError('APPLY_FAILED', 'Codex opened, but the slider session could not be recorded. Quit Codex to close the debugging connection, then reopen it from its regular icon.', 409);
    }
    const detail = pendingReason === 'ambiguous-picker' ? 'More than one Codex model picker was found. Leave one Codex window open for the next launch.'
      : pendingReason === 'picker-not-ready' ? 'The Codex model picker was not ready. Check that Codex is signed in and can open a chat.'
      : 'Codex opened, but its slider configuration was not ready.';
    throw new SliderError('APPLY_FAILED', `${detail} Your presets are saved. Quit Codex normally and launch again from Slider.`, 409);
  }
}
