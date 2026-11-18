import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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

async function editor() {
  const handlers = new Map();
  const requests = [];
  const root = {innerHTML: '', addEventListener: (name, fn) => handlers.set(name, fn)};
  const server = {presets, catalog, saved: true, consent: true, revision: 'synthetic-revision', account: 'ready',
    app: {found: true, compatible: true, running: false}, busy: false};
  const context = {
    document: {getElementById: () => root, querySelector: () => ({content: 'a'.repeat(64)})},
    window: {addEventListener() {}},
    setTimeout: () => 1, clearTimeout() {}, AbortSignal,
    fetch: async (route, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({route, body});
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
  return {root, requests, change, selectedEffort, launch};
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
