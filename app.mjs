import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store, SliderError, atomicJSON, defaultDataDirectory, readJSON, normalizeCatalog, validateDataDirectory, VERSION} from './src/core.mjs';
import {NativeBridge} from './src/native.mjs';
import {Controller} from './src/controller.mjs';
import {createServer,validSessionToken,sessionProof} from './src/server.mjs';
import {closeModelConnections} from './src/rpc.mjs';
import {CompatibilityUpdates} from './src/compatibility.mjs';

const runFile = promisify(execFile);
const entry = fileURLToPath(import.meta.url);

function argumentsFor(argv) {
  const result = {dataDirectory: defaultDataDirectory(), noBrowser: false, serve: false, disableLaunch: false};
  const values = new Map([['--data-dir', 'dataDirectory'], ['--catalog-file', 'catalogFile'], ['--app-path', 'appPath'],
    ['--import-compatibility-list','importCompatibility'],['--check-compatibility-list','checkCompatibility']]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (values.has(argument)) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('A command option is missing its value.');
      result[values.get(argument)] = path.resolve(argv[++index]);
    } else if (argument === '--no-browser') result.noBrowser = true;
    else if (argument === '--serve') result.serve = true;
    else if (argument === '--disable-launch') result.disableLaunch = true;
    else if (argument === '--desktop') {result.desktop = true; result.noBrowser = true;}
    else if (argument === '--check') result.check = true;
    else if (argument === '--set-compatibility-url') {
      if (!argv[index + 1]) throw new Error('A compatibility URL is required.');
      result.compatibilityURL = argv[++index];
    }
    else if (argument === '--help') result.help = true;
    else throw new Error('Unknown command option: ' + argument);
  }
  if (result.catalogFile && !result.disableLaunch) throw new Error('Offline catalogs require --disable-launch.');
  return result;
}

function compatibilityFor(directory, readOnly = false) {
  return new CompatibilityUpdates({directory,
    bundled:readJSON(new URL('./src/compatibility.json',import.meta.url)),
    config:readJSON(new URL('./src/compatibility-updates.json',import.meta.url)),
    bootstrap:readJSON(new URL('./src/compatibility-signed.json',import.meta.url)),readOnly});
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function assertPrivateSessionACL(file) {
  if(process.platform!=='darwin')return;
  // POSIX 0600/0700 does not revoke macOS inherited ACL grants. Deny-only
  // entries are harmless; fail closed on allow entries or an unreadable ACL.
  let stdout;
  try {({stdout}=await runFile('/bin/ls',['-lde','--',file],{
    env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'},timeout:1500,maxBuffer:65536}));}
  catch {throw new Error('The private session ACL could not be checked. Choose a private settings folder.');}
  if(/^\s*\d+:.*\ballow\b/m.test(stdout))
    throw new Error('The session folder or record has an allow ACL. Choose a private settings folder without extra access grants.');
}

export async function acquireInstance(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const owner=process.getuid?.(),directoryStat=fs.lstatSync(directory);
  if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||
    owner===undefined||directoryStat.uid!==owner||(directoryStat.mode&0o022)!==0)
    throw new Error('Use a settings directory owned by you and not writable by other users.');
  await assertPrivateSessionACL(directory);
  const lock = path.join(directory, '.instance-lock');
  const recordPath = path.join(directory, 'instance.json');
  try { fs.mkdirSync(lock, {mode: 0o700}); }
  catch (error) {
    if (error.code !== 'EEXIST' || fs.lstatSync(lock).isSymbolicLink()) throw error;
    let record;
    let descriptor;
    try {
      descriptor=fs.openSync(recordPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const stat=fs.fstatSync(descriptor);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==owner||(stat.mode&0o077)!==0)throw new Error();
      if(stat.size>16384)throw new Error();
      await assertPrivateSessionACL(recordPath);
      record = JSON.parse(fs.readFileSync(descriptor,'utf8'));
    } catch { throw new Error('The existing tool session is not private or is still starting. Close it before reopening Slider.'); }
    finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
    if (!Number.isInteger(record.pid) || record.pid < 1 || !Number.isInteger(record.port) || record.port < 0 || record.port > 65535 || typeof record.instanceID !== 'string') {
      throw new Error('The previous tool session could not be checked. Reopen it after the existing session ends.');
    }
    const running=processExists(record.pid);
    if(running&&!validSessionToken(record.token))throw new Error('Close the running older Slider before reopening this version.');
    if (running&&record.port !== 0) {
      try {
        const origin=`http://127.0.0.1:${record.port}`,challenge=crypto.randomBytes(32).toString('hex');
        const response = await fetch(`${origin}/health?challenge=${challenge}`, {redirect: 'error', signal: AbortSignal.timeout(1500)});
        const value = await response.json();
        const expected=sessionProof(record.token,record.instanceID,origin,challenge);
        if (response.ok&&value.name === 'codex-slider' && value.version === VERSION && value.instanceID === record.instanceID&&
          validSessionToken(value.proof)&&crypto.timingSafeEqual(Buffer.from(value.proof),Buffer.from(expected)))
          return {existingOrigin:origin,token:record.token};
      } catch { /* A stale session is removed only after its owner has exited. */ }
    }
    if (running) throw new Error('The running tool session could not prove its identity. Close it before trying again.');
    fs.unlinkSync(recordPath);
    fs.rmdirSync(lock);
    fs.mkdirSync(lock, {mode: 0o700});
  }
  const instanceID = crypto.randomUUID();
  atomicJSON(recordPath, {pid: process.pid, port: 0, instanceID});
  return {
    instanceID,
    ready(origin,token) {
      if(!validSessionToken(token))throw new Error('A private tool session capability is required.');
      atomicJSON(recordPath, {pid: process.pid, port: Number(new URL(origin).port), instanceID,token});
    },
    release() {
      try {
        if (readJSON(recordPath).instanceID !== instanceID) return;
        fs.unlinkSync(recordPath);
        fs.rmdirSync(lock);
      } catch { /* Preserve files belonging to a replacement session. */ }
    }
  };
}

export async function serve(options) {
  const store = new Store(options.dataDirectory);
  const instance = await acquireInstance(store.directory);
  if (instance.existingOrigin) return {origin: instance.existingOrigin, token:instance.token, reused: true};
  let local;
  try {
    const fixtureCatalog = options.catalogFile ? normalizeCatalog(readJSON(options.catalogFile), 'offline') : null;
    const compatibilityUpdates = compatibilityFor(store.directory);
    const bridge = new NativeBridge({appPath: options.appPath, directory:store.directory, disableLaunch: options.disableLaunch,
      compatibilityUpdates,
      adapters: options.disableLaunch ? {processIDs: async () => []} : {}});
    const controller = new Controller(store, bridge, {fixtureCatalog, testMode: options.disableLaunch});
    const openStandard = options.disableLaunch ? undefined : async app => {
      if (!app.found || !app.appPath) throw new SliderError('APP_MISSING', 'Install the official Codex desktop app first.');
      await runFile('/usr/bin/open', ['-a', app.appPath]);
    };
    const openSettings = options.disableLaunch ? undefined : async () => { await runFile('/usr/bin/open', [store.directory]); };
    let stopWatching = () => {};
    local = await createServer(controller, {instanceID: instance.instanceID, openStandard, openSettings,
      idleTimeout: options.desktop ? null : undefined, onClose: () => {stopWatching();instance.release();}});
    stopWatching = compatibilityUpdates.watch(change => controller.refreshCompatibility({refreshRemote:change.sourceChanged}).catch(() => {}));
    instance.ready(local.origin,local.token);
    controller.refresh().catch(() => {});
    let stopping;
    const stop = () => stopping ??= (async () => {await closeModelConnections(); await local.close();})();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (options.desktop) {
      // The native window owns this service. EOF also cleans up after a host crash.
      process.stdin.resume();
      process.stdin.once('end', stop);
      local.server.once('close', () => process.stdin.destroy());
    }
    return local;
  } catch (error) {
    if (local) await local.close();
    else instance.release();
    throw error;
  }
}

export function openBrowserSession(url,{spawnProcess=spawn}={}) {
  const parsed=new URL(url);
  if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||Number(parsed.port)<1||!parsed.port||parsed.pathname!=='/'||
    parsed.search||parsed.username||parsed.password||!/^#session=[a-f0-9]{64}$/.test(parsed.hash))throw new Error('Invalid private editor location.');
  // Never expose a bearer URL through process argv or the environment.
  return new Promise((resolve,reject)=>{
    const child=spawnProcess('/usr/bin/osascript',['-'],{stdio:['pipe','ignore','ignore']});
    let done=false;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
    const timer=setTimeout(()=>{child.kill();finish(new Error('The browser could not be opened.'));},10000);
    child.once('error',()=>finish(new Error('The browser could not be opened.')));
    child.once('exit',code=>finish(code===0?null:new Error('The browser could not be opened.')));
    child.stdin.on('error',()=>finish(new Error('The browser could not be opened.')));
    child.stdin.end('open location '+JSON.stringify(parsed.href)+'\n');
  });
}

export async function launchDetached(argv, {openBrowser = openBrowserSession} = {}) {
  const child = spawn(process.execPath, [entry, '--serve', ...argv], {detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.disconnect(); reject(new Error('The tool took too long to open. Try again.')); }, 15000);
    child.once('error', () => {clearTimeout(timeout); reject(new Error('Codex Slider could not start.'));});
    child.once('exit', code => {clearTimeout(timeout); if (code) reject(new Error('Codex Slider could not start.'));});
    child.once('message', message => {
      clearTimeout(timeout);
      if (child.connected) child.disconnect();
      if (message.error) reject(new Error(message.error));
      else if(!validSessionToken(message.token))reject(new Error('The private tool session could not be opened.'));
      else resolve(message);
    });
  });
  child.unref();
  await openBrowser(ready.origin+'/#session='+ready.token);
  console.log('Codex Slider is open in your browser. You can close this Terminal window.');
  return ready.origin+'/#session='+ready.token;
}

export async function main(argv = process.argv.slice(2)) {
  const options = argumentsFor(argv);
  if (options.importCompatibility || options.checkCompatibility || options.compatibilityURL !== undefined) {
    if ([options.importCompatibility,options.checkCompatibility,options.compatibilityURL !== undefined].filter(Boolean).length !== 1 ||
        options.catalogFile || options.appPath || options.desktop || options.serve || options.check) throw new Error('Use one compatibility maintenance command at a time.');
    const updates = compatibilityFor(validateDataDirectory(options.dataDirectory));
    if (options.checkCompatibility) {
      const {manifest} = updates.verifyFile(options.checkCompatibility);
      console.log(JSON.stringify({verified:true,sequence:manifest.sequence,builds:manifest.builds.length}));
    } else if (options.importCompatibility) console.log(JSON.stringify(await updates.importFile(options.importCompatibility)));
    else {updates.setURL(options.compatibilityURL === 'local' ? null:options.compatibilityURL);console.log(JSON.stringify({configured:true}));}
    return;
  }
  if (options.help) {
    console.log('Codex Slider ' + VERSION + '\nOpen the installed Codex Slider app to use the tool.\n\nDevelopment options: --no-browser --data-dir PATH --catalog-file PATH --disable-launch --app-path PATH --check');
    return;
  }
  if (options.check) {
    const updates = compatibilityFor(validateDataDirectory(options.dataDirectory),true);
    const app = await new NativeBridge({appPath: options.appPath, directory:options.dataDirectory, disableLaunch: true,compatibilityUpdates:updates}).inspect();
    const manifest = await updates.current();
    console.log(JSON.stringify({version: VERSION, app: {found: app.found, appPath:app.appPath, version: app.version,
      build: app.build, compatible: app.compatible, compatibilityReason:app.compatibilityReason,
      requiresRuntimeCheck:app.requiresRuntimeCheck === true,upgradeRequired:app.upgradeRequired === true,
      configurationApplied:app.configurationApplied === true,consumerVerified:false,
      automaticStatus:app.automaticStatus ?? null,
      installations:app.installations ?? []}, compatibility:{...updates.status(),
        reviewedBuilds:manifest.builds.map(({version,build,adapterVersion})=>({version,build,adapterVersion}))},appLaunched: false}, null, 2));
    return;
  }
  if (!options.noBrowser && !options.serve) { await launchDetached(argv); return; }
  const local = await serve(options);
  if (process.send) process.send({origin: local.origin,token:local.token});
  else console.log(JSON.stringify({origin: local.origin,token:local.token,reused: local.reused === true, launchDisabled: options.disableLaunch}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  main().catch(error => {
    const message = error instanceof SliderError ? error.message : (error.message || 'Codex Slider could not start.');
    if (process.send) process.send({error: message});
    else console.error(message);
    process.exitCode = 1;
  });
}
