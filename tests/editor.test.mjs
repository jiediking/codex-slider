import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID, webcrypto} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {normalizeCatalog, presetErrors} from '../src/core.mjs';
import {nativePresetAction} from '../src/native_hook.mjs';

// Exercise the shipped editor's actual change/click handlers without a browser,
// user settings, account, or Codex launch. The catalog mirrors model/list shape.
const catalog = normalizeCatalog({data: [
  {model: 'gpt-6.1-sol', supportedReasoningEfforts: [{reasoningEffort: 'high'}, {reasoningEffort: 'xhigh'}], defaultReasoningEffort: 'high'},
  {model: 'gpt-6.2-sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({reasoningEffort})), defaultReasoningEffort: 'low'},
  {model: 'limited-model', supportedReasoningEfforts: [{reasoningEffort: 'low'}], defaultReasoningEffort: 'low'},
]});
const presets = [
  {model: 'gpt-6.1-sol', reasoning_effort: 'high'},
  {model: 'gpt-6.1-sol', reasoning_effort: 'xhigh'},
  {model: 'gpt-6.2-sol', reasoning_effort: 'max'},
];

async function editor({desktop = false, respond} = {}) {
  const handlers = new Map();
  const requests = [];
  const timers = new Map();
  const hostMessages = [];
  let timerId = 0;
  const root = {innerHTML: '', addEventListener: (name, fn) => handlers.set(name, fn)};
  const server = {presets, catalog, saved: true, consent: true, revision: 'synthetic-revision', account: 'ready',
    app: {found: true, compatible: true, running: false}, busy: false};
  const context = {
    document: {getElementById: () => root, querySelector: () => ({content: 'a'.repeat(64)}),
      documentElement: {classList: {add() {}}}},
    window: {__CODEX_SLIDER_DESKTOP__: desktop, addEventListener() {},
      webkit: {messageHandlers:{sliderHost:{postMessage: message => hostMessages.push(message.type)}}}},
    crypto: webcrypto,
    setTimeout: (fn, delay) => {timers.set(++timerId, {fn, delay});return timerId;},
    clearTimeout: id => timers.delete(id), AbortSignal,
    fetch: async (route, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({route, body});
      if (respond) return {ok:true, json: async () => await respond(route, body, server)};
      if (route === '/api/launch') {
        assert.deepEqual(presetErrors(body.presets, catalog), []);
        const client = {loadingStatus: 'Ready', $emt() {}, getDynamicConfig() {
          return {value: {presets: [presets]}, get: () => [presets]};
        }};
        const adapter = {__STATSIG__: {instances: {synthetic: client}}};
        const applied = vm.runInNewContext(`(${nativePresetAction.toString()})(${JSON.stringify({presets: [body.presets]})})`, adapter);
        assert.equal(applied.installed, true);
        assert.equal(applied.readBackVerified, true);
        assert.equal(applied.consumerVerified, false);
        assert.deepEqual(JSON.parse(JSON.stringify(client.getDynamicConfig().value.presets)), [body.presets]);
        return {ok: true, json: async () => ({result: {status: 'needs-quit'}, state: {...server, presets: body.presets}})};
      }
      assert.equal(route, '/api/state');
      return {ok: true, json: async () => server};
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), context);
  await setImmediate();
  const change = (index, field, value) => handlers.get('change')({target: {dataset: {index: String(index), field}, value}});
  const selectedEffort = index => {
    const select = root.innerHTML.match(new RegExp(`<select[^>]*data-field="effort"[^>]*data-index="${index}"[^>]*>([\\s\\S]*?)</select>`));
    assert(select, 'Reasoning selector should exist');
    return select[1].match(/<option value="([^"]+)" selected>/)?.[1];
  };
  const launch = () => handlers.get('click')({target: {closest: () => ({dataset: {action: 'launch'}, disabled: false})}, detail: 0});
  const tick = async () => {
    const next = [...timers].sort((a,b) => a[1].delay - b[1].delay)[0];
    assert(next, 'An editor timer should be scheduled');
    timers.delete(next[0]);
    await next[1].fn();
  };
  return {root, requests, change, selectedEffort, launch, tick, hostMessages,
    requestClose: () => context.window.codexSliderDesktop.requestClose()};
}

test('upgrading existing High and Extra high presets to 6.2 preserves both efforts and submits distinct pairs', async () => {
  const ui = await editor();
  ui.change(0, 'model', 'gpt-6.2-sol');
  ui.change(1, 'model', 'gpt-6.2-sol');
  assert.equal(ui.selectedEffort(0), 'high');
  assert.equal(ui.selectedEffort(1), 'xhigh');
  assert(!/<button[^>]*data-action="launch" disabled/.test(ui.root.innerHTML));
  await ui.launch();
  assert.deepEqual(ui.requests.find(r => r.route === '/api/launch').body.presets, [
    {model: 'gpt-6.2-sol', reasoning_effort: 'high'},
    {model: 'gpt-6.2-sol', reasoning_effort: 'xhigh'},
    presets[2],
  ]);
});

test('switching to a model without the previous effort uses its supported default', async () => {
  const ui = await editor();
  ui.change(0, 'model', 'limited-model');
  assert.equal(ui.selectedEffort(0), 'low');
  await ui.launch();
  assert.deepEqual(ui.requests.find(r => r.route === '/api/launch').body.presets[0], {model: 'limited-model', reasoning_effort: 'low'});
});

test('explicit duplicate model/effort choices still disable launch', async () => {
  const ui = await editor();
  ui.change(0, 'model', 'gpt-6.2-sol');
  ui.change(1, 'model', 'gpt-6.2-sol');
  ui.change(0, 'effort', 'high');
  ui.change(1, 'effort', 'high');
  assert(/<button[^>]*data-action="launch" disabled/.test(ui.root.innerHTML));
  assert(ui.root.innerHTML.includes('each model and effort pair must be unique'));
});

const pending = {status:'verification-pending', configurationApplied:true, readBackVerified:true, presets};
const verified = {status:'consumer-verified', applied:true, consumerVerified:true, uiVerified:true,
  consumerEvidence:{source:'committed-slider-picker'}, presets};
const launchState = (base, id, result) => ({...base,
  app:{...base.app, running:true, consumerVerified:result.consumerVerified === true},
  lastLaunch:result, launchAttempt:{id, status:'finished'}});

test('a timed-out launch resumes verification without sending another launch and closes after success', async () => {
  let snapshot, id;
  const ui = await editor({desktop:true, respond:async (route, body, server) => {
    if (route === '/api/state') return snapshot ?? server;
    if (route === '/api/launch') {
      id = body.launchId;
      snapshot = {...server, busy:true, launchAttempt:{id, status:'running'}};
      throw new DOMException('The operation timed out.','TimeoutError');
    }
    if (route === '/api/verification/check') {
      snapshot = launchState(server,id,verified);
      return {state:snapshot, result:verified};
    }
    assert.equal(route, '/api/close');
    return {closed:true};
  }});
  await ui.launch();
  assert.match(id, /^[0-9a-f]{32}$/);
  await ui.tick();
  assert(ui.root.innerHTML.includes('Opening Codex'));
  snapshot = launchState({...snapshot, busy:false},id,pending);
  await ui.tick();
  assert(ui.root.innerHTML.includes('Your slider is ready'));
  await ui.tick();
  assert.deepEqual(ui.hostMessages, ['ready','closed']);
  assert.equal(ui.requests.filter(request=>request.route === '/api/launch').length, 1);
});

test('launch recovery waits for its own result and displays a server-side failure', async () => {
  for (const otherLaunch of [true,false]) {
    let snapshot;
    const ui = await editor({desktop:true, respond:async (route,body,server) => {
      if (route === '/api/state') return snapshot ?? server;
      assert.equal(route, '/api/launch');
      snapshot = otherLaunch ? launchState(server,randomUUID(),verified) :
        {...server, launchAttempt:{id:body.launchId, status:'failed',
          error:{code:'APPLY_FAILED', message:'Could not apply presets.'}}};
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }});
    await ui.launch();
    await ui.tick();
    assert(!ui.root.innerHTML.includes('Your slider is ready'));
    assert(ui.root.innerHTML.includes(otherLaunch ? 'could not be confirmed' : 'Could not apply presets.'));
    assert.deepEqual(ui.hostMessages,['ready']);
  }
});

test('a state request sent before launch recovery cannot end recovery with an old idle snapshot', async () => {
  let holdPoll = false, returnOldState, snapshot;
  const ui = await editor({desktop:true, respond:async (route,body,server) => {
    if (route === '/api/state') {
      if (!holdPoll) return snapshot ?? server;
      holdPoll = false;
      return new Promise(resolve => {returnOldState = () => resolve(server);});
    }
    assert.equal(route, '/api/launch');
    snapshot = {...server, busy:true, launchAttempt:{id:body.launchId,status:'running'}};
    throw new DOMException('The operation timed out.', 'TimeoutError');
  }});
  holdPoll = true;
  const oldPoll = ui.tick();
  await setImmediate();
  await ui.launch();
  returnOldState();
  await oldPoll;
  await ui.tick();
  assert(ui.root.innerHTML.includes('Opening Codex'));
  assert(!ui.root.innerHTML.includes('could not be confirmed'));
  assert.equal(ui.requests.filter(request=>request.route === '/api/launch').length, 1);
});

test('a close request during launch does not prevent the verified editor from closing', async () => {
  let resolveLaunch, id, snapshot;
  const ui = await editor({desktop:true, respond:async (route,body,server) => {
    if (route === '/api/state') return snapshot ?? server;
    if (route === '/api/launch') {
      id = body.launchId;
      snapshot = launchState(server,id,pending);
      return new Promise(resolve => {resolveLaunch = resolve;});
    }
    if (route === '/api/verification/check') {
      snapshot = launchState(server,id,verified);
      return {state:snapshot, result:verified};
    }
    assert.equal(route, '/api/close');
    return {closed:true};
  }});
  const opening = ui.launch();
  await setImmediate();
  ui.requestClose();
  assert(ui.root.innerHTML.includes('Please wait for the current operation to finish before closing.'));
  resolveLaunch({state:snapshot, result:pending});
  await opening;
  await ui.tick();
  assert(ui.root.innerHTML.includes('Your slider is ready'));
  assert(!ui.root.innerHTML.includes('Please wait for the current operation to finish before closing.'));
  await ui.tick();
  assert.deepEqual(ui.hostMessages,['ready','closed']);
});
