import {spawn} from 'node:child_process';
import {SliderError, normalizeCatalog, VERSION} from './core.mjs';

const ALLOWED = new Set(['initialize', 'account/read', 'model/list']);
const activeClients = new Set();

export async function closeModelConnections() {
  await Promise.allSettled([...activeClients].map(client => client.close()));
}

export class StdioClient {
  constructor(command, args = ['app-server'], {timeout = 12000, spawnProcess = spawn} = {}) {
    this.timeout = timeout;
    this.pending = new Map();
    this.nextID = 0;
    this.buffer = '';
    this.failure = null;
    this.child = spawnProcess(command, args, {stdio: ['pipe', 'pipe', 'ignore']});
    activeClients.add(this);
    this.child.once('exit', () => activeClients.delete(this));
    this.child.once('error', () => activeClients.delete(this));
    this.child.on('error', () => this.fail('Codex model discovery could not start.'));
    this.child.on('exit', () => this.fail('Codex model discovery closed unexpectedly.'));
    this.child.stdin.on('error', () => this.fail('The Codex model connection was interrupted.'));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
  }

  fail(message) {
    this.failure = new SliderError('DISCOVERY_FAILED', message);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  send(value) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  receive(chunk) {
    if (this.failure) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) return this.fail('The Codex model response exceeded the size limit.');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail('Codex returned an invalid model response.'); return; }
      if (!message || typeof message !== 'object') { this.fail('Codex returned an invalid model response.'); return; }
      if (message.method) {
        if (message.id != null) this.send({id: message.id, error: {code: -32601, message: 'Unsupported by Codex Slider'}});
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new SliderError('DISCOVERY_FAILED', `Codex model discovery failed (${message.error.code ?? 'unknown'}).`));
      else if (!message.result || typeof message.result !== 'object') pending.reject(new SliderError('DISCOVERY_FAILED', 'Codex returned an invalid model result.'));
      else pending.resolve(message.result);
    }
  }

  request(method, params) {
    if (!ALLOWED.has(method)) return Promise.reject(new SliderError('METHOD_BLOCKED', 'This connection only reads account status and models.'));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextID;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SliderError('DISCOVERY_TIMEOUT', 'Reading models timed out. Try refreshing models.'));
      }, this.timeout);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) {clearTimeout(timer); this.pending.delete(id); reject(error);}
    });
  }

  async close() {
    if (this.closing) return this.closing;
    this.closing = this.closeChild();
    return this.closing;
  }

  async closeChild() {
    activeClients.delete(this);
    this.fail('Model discovery has ended.');
    this.child.stdin.end();
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 800);
      const force = setTimeout(() => this.child.kill('SIGKILL'), 1800);
      this.child.once('exit', () => {clearTimeout(timer); clearTimeout(force); resolve();});
    });
  }
}

export async function discoverModels(command, options = {}) {
  const client = new StdioClient(command, options.args ?? ['app-server'], options);
  try {
    await client.request('initialize', {clientInfo: {name: 'codex_slider', title: 'Codex Slider', version: VERSION}});
    client.send({method: 'initialized', params: {}});
    const {account} = await client.request('account/read', {refreshToken: false});
    if (account?.type !== 'chatgpt') throw new SliderError('SIGN_IN_REQUIRED', 'Sign in with ChatGPT in Codex, then refresh models.');
    const rows = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < 64; page++) {
      const result = await client.request('model/list', {limit: 50, includeHidden: false, ...(cursor ? {cursor} : {})});
      if (!Array.isArray(result.data)) throw new SliderError('CATALOG_INVALID', 'Codex did not return a model list.');
      rows.push(...result.data);
      if (result.nextCursor == null) return normalizeCatalog({data: rows, nextCursor: null});
      cursor = result.nextCursor;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new SliderError('CATALOG_INVALID', 'Codex returned an invalid model page cursor.');
      seen.add(cursor);
    }
    throw new SliderError('CATALOG_INVALID', 'The model catalog exceeded the page limit.');
  } finally {
    await client.close();
  }
}
