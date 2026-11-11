import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJSON} from './core.mjs';

export const ADAPTER_VERSION = 2;
const LIMIT = 256 * 1024;
const DAY = 86400000;
const UNKNOWN_RETRY = 3600000;
export const LOCAL_FEED = 'compatibility-feed.json';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

export function validAssetPath(value) {
  return typeof value === 'string' && value.length <= 240 &&
    /^webview\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(value) &&
    !value.split('/').some(part => part === '.' || part === '..');
}

export function validateManifest(value) {
  if (!exact(value, ['schemaVersion', 'sequence', 'bundleId', 'builds']) || value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 0 || value.bundleId !== 'com.openai.codex' ||
      !Array.isArray(value.builds) || value.builds.length > 128) throw new Error('Invalid compatibility manifest.');
  const seen = new Set();
  for (const entry of value.builds) {
    if (!exact(entry, ['version', 'build', 'adapterVersion', 'rendererSha256', 'assets']) ||
        typeof entry.version !== 'string' || !/^[A-Za-z0-9.-]{1,80}$/.test(entry.version) ||
        typeof entry.build !== 'string' || !/^\d{1,12}$/.test(entry.build) ||
        !Number.isSafeInteger(entry.adapterVersion) || entry.adapterVersion < 1 ||
        seen.has(entry.version + '/' + entry.build)) throw new Error('Invalid compatibility build.');
    seen.add(entry.version + '/' + entry.build);
    if (entry.rendererSha256 !== undefined) {
      if (!sha(entry.rendererSha256) || entry.assets !== undefined) throw new Error('Invalid legacy fingerprint.');
    } else {
      if (!Array.isArray(entry.assets) || !entry.assets.length || entry.assets.length > 32) throw new Error('Missing asset fingerprints.');
      const paths = new Set();
      for (const asset of entry.assets) {
        if (!exact(asset, ['path', 'sha256']) || !validAssetPath(asset.path) || !sha(asset.sha256) || paths.has(asset.path)) {
          throw new Error('Invalid asset fingerprint.');
        }
        paths.add(asset.path);
      }
    }
  }
  return value;
}

function base64(value) {
  if (typeof value !== 'string' || !value.length || value.length > LIMIT ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid signed data.');
  return Buffer.from(value, 'base64');
}

export function verifyEnvelope(envelope, publicKey) {
  if (!exact(envelope, ['payload', 'signature'])) throw new Error('Invalid compatibility envelope.');
  const key = crypto.createPublicKey(publicKey);
  const payload = base64(envelope.payload);
  const signature = base64(envelope.signature);
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !crypto.verify(null, payload, key, signature)) {
    throw new Error('Compatibility signature rejected.');
  }
  return validateManifest(JSON.parse(payload.toString('utf8')));
}

export function validUpdateConfig(config) {
  try {
    return crypto.createPublicKey(config.publicKey).asymmetricKeyType === 'ed25519' &&
      (config.url == null ? config.localFile === LOCAL_FEED : validHTTPS(config.url)) &&
      (config.localFile == null || config.localFile === LOCAL_FEED);
  } catch { return false; }
}

function validHTTPS(value) {
  try {const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash;}
  catch {return false;}
}

function readBounded(file, limit = LIMIT) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Invalid compatibility data file.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function boundedJSON(response) {
  if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > LIMIT || !response.body) {
    throw new Error('Compatibility download rejected.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT) throw new Error('Compatibility download is too large.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export class CompatibilityUpdates {
  constructor({directory, bundled, config, bootstrap = null, fetcher = fetch, now = Date.now, readOnly = false}) {
    this.file = path.join(directory, 'compatibility-cache.json');
    this.feedFile = path.join(directory, LOCAL_FEED);
    this.sourceFile = path.join(directory, 'compatibility-source.json');
    this.bundled = validateManifest(bundled);
    this.config = config;
    this.bootstrap = bootstrap;
    this.fetcher = fetcher;
    this.now = now;
    this.readOnly = readOnly;
    this.state = {configured:validUpdateConfig(config), source:'unconfigured', status:'unconfigured', sequence:bundled.sequence};
  }

  status() { return {...this.state}; }

  setURL(url) {
    if (this.readOnly) throw new Error('This compatibility session is read-only.');
    if (!validUpdateConfig(this.config) || (url !== null && !validHTTPS(url))) throw new Error('Use an HTTPS compatibility URL without credentials or fragment.');
    atomicJSON(this.sourceFile, {url});
  }

  verifyFile(file) {
    if (!validUpdateConfig(this.config)) throw new Error('No trusted compatibility public key is configured.');
    const envelope = readBounded(file);
    return {envelope, manifest:verifyEnvelope(envelope, this.config.publicKey)};
  }

  async importFile(file) {
    if (this.readOnly) throw new Error('This compatibility session is read-only.');
    if (this.config.localFile !== LOCAL_FEED) throw new Error('This App has no local compatibility channel.');
    const {envelope, manifest} = this.verifyFile(file);
    const current = await this.current();
    let accepted = null;
    try {accepted = readBounded(this.file, LIMIT * 2).envelope;} catch {}
    if (manifest.sequence < current.sequence || (manifest.sequence === current.sequence && envelope.payload !== accepted?.payload)) {
      throw new Error('An older or changed same-sequence compatibility list was rejected.');
    }
    atomicJSON(this.feedFile, envelope);
    await this.current();
    return {sequence:manifest.sequence, builds:manifest.builds.length, source:'local'};
  }

  watch(callback) {
    if (!validUpdateConfig(this.config)) return () => {};
    const files = [this.sourceFile, ...(this.config.localFile === LOCAL_FEED ? [this.feedFile] : [])];
    for (const file of files) {
      const token = stat => `${stat.ino}/${stat.mtimeMs}/${stat.size}`;
      let previous;
      try {previous=token(fs.statSync(file));} catch {previous='0/0/0';}
      fs.watchFile(file, {interval:1000,persistent:false}, stat => {
        const current=token(stat);if(current===previous)return;previous=current;
        callback({sourceChanged:file===this.sourceFile});
      });
    }
    return () => {for (const file of files) fs.unwatchFile(file);};
  }

  async current({refresh = false, unknownBuild = null, force = false} = {}) {
    if (!validUpdateConfig(this.config)) {
      this.state = {configured:false,source:'unconfigured',status:'unconfigured',sequence:this.bundled.sequence};
      return this.bundled;
    }
    let manifest = this.bundled;
    let envelope = null;
    let cache = {};
    let error = null;
    let seedAdvanced = false;
    try {
      cache = readBounded(this.file, LIMIT * 2);
      if (cache.envelope) {
        const cached = verifyEnvelope(cache.envelope, this.config.publicKey);
        if (cached.sequence < this.bundled.sequence) throw new Error('Outdated cache.');
        manifest = cached; envelope = cache.envelope;
      }
    } catch { cache = {}; }
    const advance = candidate => {
      const updated = verifyEnvelope(candidate, this.config.publicKey);
      if (updated.sequence > manifest.sequence || (updated.sequence === manifest.sequence && candidate.payload === envelope?.payload)) {
        manifest = updated; envelope = candidate;
      } else throw new Error('Compatibility rollback rejected.');
    };
    if (this.bootstrap) {
      try {
        const seed = verifyEnvelope(this.bootstrap, this.config.publicKey);
        if (seed.sequence > manifest.sequence) {advance(this.bootstrap);seedAdvanced = true;}
      } catch { error = 'The bundled compatibility signature could not be verified.'; }
    }
    let url = this.config.url;
    if (fs.existsSync(this.sourceFile)) {
      try {
        const source = readBounded(this.sourceFile, 4096);
        if (!exact(source,['url']) || !Object.hasOwn(source,'url') || (source.url !== null && !validHTTPS(source.url))) throw new Error();
        url = source.url;
      } catch {error = 'The compatibility update source is invalid. Last verified data is kept.';}
    }
    const local = this.config.localFile === LOCAL_FEED;
    if (!this.readOnly && local && !fs.existsSync(this.feedFile) && envelope) {
      try {atomicJSON(this.feedFile, envelope);} catch {error = 'The local compatibility list could not be saved.';}
    }
    if (local && fs.existsSync(this.feedFile)) {
      try {
        const candidate = readBounded(this.feedFile);
        const localManifest = verifyEnvelope(candidate, this.config.publicKey);
        if (localManifest.sequence < manifest.sequence && seedAdvanced) {if (!this.readOnly) atomicJSON(this.feedFile,envelope);}
        else if (localManifest.sequence < manifest.sequence && url) { /* HTTPS cache is newer than its local fallback. */ }
        else advance(candidate);
      }
      catch {error = 'The local compatibility list was rejected. Last verified data is kept.';}
    }
    const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= this.now();
    const dailyDue = cache.lastSourceURL !== url || !validTime(cache.lastCheckedAt) || this.now() - cache.lastCheckedAt >= DAY;
    const unknownDue = typeof unknownBuild === 'string' && unknownBuild.length < 100 &&
      (cache.lastUnknownBuild !== unknownBuild || !validTime(cache.lastUnknownAt) || this.now() - cache.lastUnknownAt >= UNKNOWN_RETRY);
    if (url && refresh && (force || dailyDue || unknownDue)) {
      try {
        const response = await this.fetcher(url, {redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(3000)});
        advance(await boundedJSON(response));
        error = null;
        if (local && !this.readOnly) atomicJSON(this.feedFile,envelope);
      } catch {error = 'The compatibility update could not be verified or downloaded. Last verified data is kept.';}
      cache.lastCheckedAt = this.now();
      cache.lastSourceURL = url;
      if (unknownBuild) {cache.lastUnknownBuild = unknownBuild;cache.lastUnknownAt = this.now();}
    }
    const nextCache = {...cache,envelope};
    try {if (!this.readOnly && JSON.stringify(nextCache) !== JSON.stringify(cache)) atomicJSON(this.file, nextCache);}
    catch { /* Read-only storage must not prevent using the editor. */ }
    // Network attempts must be rate-limited even when no list was accepted.
    if (!this.readOnly && url && refresh && (force || dailyDue || unknownDue)) {
      try {atomicJSON(this.file, nextCache);} catch {}
    }
    this.state = {configured:true,source:url ? 'https':'local',status:error ? 'error':envelope ? 'ready':'waiting',
      sequence:manifest.sequence,url:url ?? null,message:error};
    return manifest;
  }
}
