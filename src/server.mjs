import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SliderError, VERSION} from './core.mjs';

const webDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const MAX_BODY = 128 * 1024;

export const validSessionToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const sessionProof=(token,instanceID,origin,challenge)=>crypto.createHmac('sha256',token)
  .update(JSON.stringify([instanceID,VERSION,origin,challenge])).digest('hex');

async function bodyJSON(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new SliderError('BAD_REQUEST', 'Use a JSON request.', 415);
  if (Number(request.headers['content-length']) > MAX_BODY) {
    request.resume();
    throw new SliderError('BODY_TOO_LARGE', 'The request is too large.', 413);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new SliderError('BODY_TOO_LARGE', 'The request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new SliderError('BAD_JSON', 'The request is not valid JSON.'); }
}

export async function createServer(controller, {port = 0, onClose = () => {}, openStandard, openSettings,
  instanceID = crypto.randomUUID(), idleTimeout = 10 * 60 * 1000} = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const authenticated=request=>{
    const supplied=request.headers['x-codex-slider-token'];
    return validSessionToken(supplied)&&crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(token));
  };
  let origin;
  let lastActivity = Date.now();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const json = (status, value) => {
      response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(origin).host) throw new SliderError('HOST_BLOCKED', 'Invalid local host.', 403);
      if (request.headers.origin && request.headers.origin !== origin) throw new SliderError('ORIGIN_BLOCKED', 'Only the local editor can make this request.', 403);
      if (['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) throw new SliderError('ORIGIN_BLOCKED', 'Open the local editor directly.', 403);
      const url = new URL(request.url, origin);
      const asset = assets.get(url.pathname);
      if (request.method === 'GET' && asset) {
        let content = await fs.readFile(path.join(webDirectory, asset[0]));
        // The public document is a static shell. Only a client that already
        // received the capability privately may receive a token-bearing page.
        if (url.pathname === '/') content = content.toString('utf8').replace('__SESSION_TOKEN__', authenticated(request)?token:'');
        lastActivity = Date.now();
        response.writeHead(200, {'Content-Type': asset[1]});
        response.end(content);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        const challenge=url.searchParams.get('challenge');
        json(200, {name: 'codex-slider', version: VERSION, instanceID,
          ...(validSessionToken(challenge)?{proof:sessionProof(token,instanceID,origin,challenge)}:{})});
        return;
      }
      if (!authenticated(request)) {
        throw new SliderError('SESSION_REQUIRED', 'Reopen this page from Codex Slider.', 403);
      }
      lastActivity = Date.now();
      if (request.method === 'GET' && url.pathname === '/api/state') { json(200, controller.snapshot()); return; }
      if (request.method !== 'POST') throw new SliderError('NOT_FOUND', 'This action was not found.', 404);
      const body = await bodyJSON(request);
      if (url.pathname === '/api/refresh') json(200, await controller.refresh({forceCompatibility:true}));
      else if (url.pathname === '/api/compatibility/check') json(200, await controller.checkCompatibility());
      else if (url.pathname === '/api/save') json(200, controller.save(body));
      else if (url.pathname === '/api/launch') json(200, await controller.launch(body));
      else if (url.pathname === '/api/verification/check') json(200, await controller.verifySlider());
      else if (url.pathname === '/api/open-codex') {
        if (!openStandard) throw new SliderError('OPEN_DISABLED', 'Opening Codex is disabled in this test session.', 409);
        await openStandard(controller.app);
        json(200, {opened: true});
      } else if (url.pathname === '/api/open-settings') {
        if (!openSettings) throw new SliderError('OPEN_DISABLED', 'Opening Finder is disabled in this test session.', 409);
        await openSettings(); json(200, {opened: true});
      } else if (url.pathname === '/api/close') {
        if (controller.busy) throw new SliderError('BUSY', 'Please wait for the current operation to finish.', 409);
        json(200, {closed: true});
        setTimeout(() => close(), 50);
      } else throw new SliderError('NOT_FOUND', 'This action was not found.', 404);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      json(error instanceof SliderError ? error.status : 500, {error: {
        code: error instanceof SliderError ? error.code : 'INTERNAL_ERROR',
        message: error instanceof SliderError ? error.message : 'The operation could not be completed. Try again.'}});
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);});
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = idleTimeout == null ? null : setInterval(() => {
    if (!controller.busy && Date.now() - lastActivity > idleTimeout) close();
  }, Math.min(idleTimeout, 30000));
  timer?.unref();
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await new Promise(resolve => {server.close(resolve); server.closeIdleConnections();});
    await onClose();
  }
  // This value is handed to the native parent/authorized CLI over private IPC.
  return {origin, token, instanceID, close, server};
}
