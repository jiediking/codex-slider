import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge, evaluatePresets, evaluateConsumer} from '../src/native.mjs';
import {validateConsumerObservation} from '../src/consumer.mjs';
import {Controller} from '../src/controller.mjs';
import {verifyOfficialInstallation} from '../src/automatic.mjs';
import {SliderError} from '../src/core.mjs';

const oldPresets = ['low', 'high', 'xhigh'].map(reasoning_effort => ({model: 'previous-model', reasoning_effort}));
const presets = [
  {model: 'gpt-6.2-sol', reasoning_effort: 'high'},
  {model: 'gpt-6.2-sol', reasoning_effort: 'xhigh'},
  {model: 'gpt-6.2-astra', reasoning_effort: 'max'},
];

const fixtureApp = {
  found: true, compatible: true, appPath: '/synthetic/Codex.app',
  executable: '/synthetic/Codex.app/Contents/MacOS/Codex',
  cli: '/synthetic/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  version: 'test', build: '1', rendererSha256: 'a'.repeat(64),
};

test('a failed publisher check blocks model discovery and both normal open paths, even for a listed build', async () => {
  let identityChecks = 0;
  const bridge = new NativeBridge({adapters:{
    inspectApp: async () => fixtureApp, processIDs: async () => [],
    verifyOfficialInstallation: async () => {identityChecks++;return null;},
    inspectAutomatic: async () => assert.fail('An unverified app must not enter automatic compatibility'),
    launchApplication: async () => assert.fail('An unverified app must not launch'),
    openApplication: async () => assert.fail('An unverified app must not open'),
  }});
  const store = {setCatalog: () => assert.fail('An unverified app must not provide a catalog'), snapshot: () => ({})};
  const controller = new Controller(store, bridge, {loadModels:async () => assert.fail('An unverified model reader must not run')});
  const state = await controller.refresh();
  assert.equal(state.account, 'error');
  assert.equal(state.app.automaticStatus, 'unverified-installation');
  assert.equal(state.app.compatible, false);
  await assert.rejects(bridge.launch({app: fixtureApp, standard: true}), {code:'INSTALLATION_UNVERIFIED'});
  await assert.rejects(bridge.launch({app: fixtureApp, presets, consent: true}), {code:'INSTALLATION_UNVERIFIED'});
  await assert.rejects(bridge.openStandard(fixtureApp), {code:'INSTALLATION_UNVERIFIED'});
  assert.equal(identityChecks, 4);
});

test('official listed and unlisted installs can read models and open Codex normally', async () => {
  for (const compatible of [true, false]) {
    const app = {...fixtureApp, compatible};
    const calls = [];
    const bridge = new NativeBridge({adapters:{
      inspectApp: async () => app, processIDs: async () => [],
      verifyOfficialInstallation: async app => {calls.push('identity');return {...app, identityVerified:true};},
      inspectAutomatic: async app => {
        assert.equal(app.identityVerified, true);
        calls.push('automatic');
        return {...app, compatible:true, requiresRuntimeCheck:true};
      },
      launchApplication: async (_, args) => {assert.deepEqual(args, []);calls.push('launch');return 444;},
      openApplication: async () => {calls.push('open');},
    }});
    const catalog = {models:[{id: 'new-model'}]};
    const store = {setCatalog: value => assert.equal(value, catalog), snapshot: () => ({})};
    const controller = new Controller(store, bridge, {loadModels:async cli => {
      assert.equal(cli, app.cli);
      calls.push('models');
      return catalog;
    }});
    const state = await controller.refresh();
    const compatibilityChecks = compatible ? ['identity'] : ['identity','automatic'];
    assert.deepEqual(calls, [...compatibilityChecks, 'models']);
    assert.equal(state.account, 'ready');
    assert.equal(state.app.compatible, true);
    assert.equal(state.app.requiresRuntimeCheck, !compatible);
    assert.equal((await bridge.launch({app, standard:true})).status, 'standard-opened');
    await bridge.openStandard(app);
    assert.deepEqual(calls.slice(compatibilityChecks.length + 1), [...compatibilityChecks, 'launch', 'identity', 'open']);
  }
});

test('publisher verification binds the launch and CLI paths to the inspected bundle', async () => {
  const target = '/synthetic/Canonical/Codex.app';
  const run = async (binary, args) => {
    assert.equal(binary, '/usr/bin/codesign');
    assert(args.includes('--deep'));
    assert(args[args.indexOf('-R') + 1].includes('com.openai.codex'));
    assert.equal(args.at(-1), target);
  };
  const resolve = async file => target + file.slice(fixtureApp.appPath.length);
  const app = await verifyOfficialInstallation(fixtureApp, {run, realpath: resolve});
  assert.equal(app.identityVerified, true);
  assert.equal(app.appPath, target);
  assert(app.executable.startsWith(target + '/'));
  assert(app.cli.startsWith(target + '/'));
  const outside = file => file === fixtureApp.cli ? '/synthetic/untrusted-reader' : resolve(file);
  let outsideChecks = 0;
  assert.equal(await verifyOfficialInstallation(fixtureApp, {
    run: () => {outsideChecks++;}, realpath: outside,
  }), null);
  assert.equal(outsideChecks, 0);
  assert.equal(await verifyOfficialInstallation(fixtureApp, {
    run: async () => {throw new Error('Rejected signature');}, realpath: resolve,
  }), null);
});

test('controller identifies a launch through completion, and a busy rejection cannot replace it', async () => {
  let complete;
  const bridge = {launch: () => new Promise(resolve => {complete = resolve;})};
  const controller = new Controller({
    assertRevision(revision) {
      if (revision === 'stale') throw new SliderError('SETTINGS_CHANGED', 'Fixture settings changed.', 409);
    },
    snapshot: () => ({}),
  }, bridge);
  const launchId = 'a'.repeat(32);
  const pending = controller.launch({launchId, standard:true});
  assert.equal(controller.snapshot().busy, true);
  assert.deepEqual(controller.snapshot().launchAttempt, {id:launchId, status:'running'});
  await assert.rejects(controller.launch({launchId:'b'.repeat(32), standard:true}), {code:'BUSY'});
  assert.deepEqual(controller.snapshot().launchAttempt, {id:launchId, status:'running'});
  const result = {status:'standard-opened'};
  complete(result);
  const value = await pending;
  assert.deepEqual(value.state.launchAttempt, {id:launchId, status:'finished'});
  assert.deepEqual(value.state.lastLaunch, result);

  const nextId = 'b'.repeat(32);
  await assert.rejects(controller.launch({launchId:nextId, standard:true, revision:'stale'}), {code:'SETTINGS_CHANGED'});
  assert.deepEqual(controller.snapshot().launchAttempt, {id:launchId, status:'finished'});
  bridge.launch = async () => {throw new SliderError('LAUNCH_FAILED', 'Fixture launch failed.', 409);};
  await assert.rejects(controller.launch({launchId:nextId, standard:true}), {code:'LAUNCH_FAILED'});
  assert.deepEqual(controller.snapshot().launchAttempt, {id:nextId, status:'failed',
    error:{code:'LAUNCH_FAILED', message:'Fixture launch failed.'}});
  assert.equal(controller.snapshot().lastLaunch, null);
});

// A local CDP transport and committed React picker, with no real browser or Codex.
// Production expressions execute unchanged, including the actual SDK hook and observer.
function renderer(id, {picker = true, marker = picker, incompatible = false, delayed = false} = {}) {
  const client = {loadingStatus: 'Ready', updates: 0, getDynamicConfig() {
    return {value: {presets: incompatible ? 'changed-schema' : [oldPresets]}, get: () => [oldPresets]};
  }, $emt() {this.updates++; if (!delayed) sync();}};
  const trigger = {isConnected: true, disabled: false, getClientRects: () => [1], getAttribute: name => name === 'data-selected-reasoning-effort' ? owner.memoizedProps.selectedPowerSelection.reasoningEffort : null};
  const root = {tag: 3, memoizedProps: {}};
  root.stateNode = {current: root};
  const context = {return: root, memoizedProps: {open: false, selectionMode: 'default', onSelectModel() {},
    models: ['previous-model', 'gpt-6.2-sol', 'gpt-6.2-astra'].map(model => ({model, supportedReasoningEfforts: ['low', 'high', 'xhigh', 'max'].map(reasoningEffort => ({reasoningEffort}))}))}};
  const owner = {return: context, memoizedProps: picker ? {open: false, isExplicitModelSelection: false, onSelectPower() {}} : {}};
  const control = {return: owner, stateNode: trigger, memoizedProps: {}};
  root.child = context; context.child = owner; owner.child = control;
  trigger.__reactFiber$synthetic = control;
  function sync() {
    const config = client.getDynamicConfig('423260384').value.presets;
    const group = Array.isArray(config) ? config[0] : oldPresets;
    const rows = group.map((p, i) => ({id: `${p.model}:${p.reasoning_effort}`, model: p.model, reasoningEffort: p.reasoning_effort, powerSettingIndex: i}));
    owner.memoizedProps.powerSelections = rows;
    owner.memoizedProps.selectedPowerSelection = rows[0];
    context.memoizedProps.powerSelections = rows;
    context.memoizedProps.model = rows[0].model;
    context.memoizedProps.reasoningEffort = rows[0].reasoningEffort;
    control.memoizedProps['data-selected-reasoning-effort'] = rows[0].reasoningEffort;
  }
  sync();
  const runtime = vm.createContext({__STATSIG__: {instances: {synthetic: client}},
    document: {querySelectorAll: selector => marker && selector === '[data-selected-reasoning-effort]' ? [trigger] : []},
    getComputedStyle: () => ({visibility: 'visible', display: 'block'})});
  return {id, client, runtime, owner, sync, target: {id, type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:12345/${id}`}};
}

function transport(t, initial) {
  let pages = initial;
  const fetchBefore = globalThis.fetch, socketBefore = globalThis.WebSocket;
  t.after(() => {globalThis.fetch = fetchBefore; globalThis.WebSocket = socketBefore;});
  globalThis.fetch = async () => ({ok: true, text: async () => JSON.stringify(pages.map(p => p.target))});
  globalThis.WebSocket = class {
    constructor(url) {this.page = pages.find(p => p.target.webSocketDebuggerUrl === url); queueMicrotask(() => this.onopen());}
    send(value) {
      const message = JSON.parse(value);
      let result;
      try { result = {result: {value: vm.runInContext(message.params.expression, this.page.runtime)}}; }
      catch (error) { result = {exceptionDetails: {text: error.message}}; }
      queueMicrotask(() => this.onmessage({data: JSON.stringify({id: message.id, result})}));
    }
    close() {}
  };
  return {replace: next => {pages = next;}};
}

test('apply 6.2 presets to the real picker, ignoring an earlier background configuration client', async t => {
  const background = renderer('background', {picker: false});
  const main = renderer('main');
  transport(t, [background, main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(background.client.updates, 0);
  assert.equal(main.client.updates, 1);
  assert.equal(result.rendererId, 'main');
  assert.equal(validateConsumerObservation(await evaluateConsumer(12345, result.rendererId), presets).status, 'matched');
});

test('a committed lookalike marker without a picker owner cannot block application', async t => {
  const unrelated = renderer('unrelated', {picker: false, marker: true});
  const main = renderer('main');
  transport(t, [unrelated, main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.rendererId, 'main');
  assert.equal(unrelated.client.updates, 0);
});

test('an unrelated page with a changed SDK schema cannot mark the actual slider incompatible', async t => {
  const unrelated = renderer('unrelated', {picker: false, incompatible: true});
  const main = renderer('main');
  transport(t, [unrelated, main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.installed, true);
  assert.equal(result.rendererId, 'main');
  assert.equal(unrelated.client.updates, 0);
});

test('a schema change in the actual picker still reports incompatible without injecting presets', async t => {
  const main = renderer('main', {incompatible: true});
  transport(t, [main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.compatibility, 'incompatible');
  assert.equal(main.client.updates, 0);
});

test('an unrelated ready client cannot establish a schema change in the actual picker', async t => {
  const main = renderer('main');
  vm.runInContext('__STATSIG__.instances = {loading: {loadingStatus: "Loading"}, other: {loadingStatus: "Ready"}}', main.runtime);
  transport(t, [main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.compatibility, 'pending');
  assert.equal(result.installed, false);
});

test('multiple actual picker pages stay pending without applying to the first one', async t => {
  const a = renderer('a'), b = renderer('b');
  transport(t, [a, b]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.installed, false);
  assert.equal(result.compatibility, 'pending');
  assert.equal(a.client.updates + b.client.updates, 0);
});

test('an SDK-only page cannot accept slider presets before its picker is committed', async t => {
  const background = renderer('background', {picker: false});
  transport(t, [background]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.reason, 'picker-not-ready');
  assert.equal(background.client.updates, 0);
});

test('verification remains on the injected page when another picker appears, and never falls back after it disappears', async t => {
  const main = renderer('main'), other = renderer('other');
  const session = transport(t, [main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  session.replace([other, main]);
  const observed = await evaluateConsumer(12345, result.rendererId);
  assert.equal(validateConsumerObservation(observed, presets).status, 'matched');
  session.replace([other]);
  assert.equal((await evaluateConsumer(12345, result.rendererId)).status, 'pending');
});

test('an explicit model can locate the picker but never counts as verified Default presets', async t => {
  const main = renderer('main');
  main.owner.memoizedProps.isExplicitModelSelection = true;
  transport(t, [main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.installed, true);
  const observation = await evaluateConsumer(12345, result.rendererId);
  assert.equal(observation.reason, 'use-default-slider');
  assert.equal(validateConsumerObservation(observation, presets).status, 'pending');
  delete main.owner.memoizedProps.isExplicitModelSelection;
  assert.equal((await evaluateConsumer(12345, result.rendererId)).reason, 'consumer-not-ready');
});

test('a hidden picker is skipped even when its SDK and committed DOM are ready', async t => {
  const hidden = renderer('hidden'), main = renderer('main');
  vm.runInContext('document.visibilityState="hidden"', hidden.runtime);
  transport(t, [hidden, main]);
  const result = await evaluatePresets(12345, {presets: [presets]});
  assert.equal(result.rendererId, 'main');
  assert.equal(hidden.client.updates, 0);
});

test('slow rendering stays retryable on the injected page and a later stable match confirms the slider', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slider-native-session-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const main = renderer('main', {delayed: true}), other = renderer('other');
  const targets = transport(t, [main]);
  const app = {found: true, compatible: true, appPath: '/synthetic/Codex.app', executable: '/synthetic/Codex.app/Contents/MacOS/Codex', version: 'test', build: '1', rendererSha256: 'a'.repeat(64)};
  let running = false, now = 0;
  const observedIds = [];
  const bridge = new NativeBridge({directory: dir, adapters: {
    inspectApp: async () => app, verifyOfficialInstallation: async app => ({...app, identityVerified:true}),
    processIDs: async () => running ? [444] : [],
    installationStamp: async () => 'same-installation', freePort: async () => 12345,
    launchApplication: async () => {running = true; return 444;}, now: () => now,
    evaluateConsumer: async (port, id) => {observedIds.push(id); return evaluateConsumer(port, id);},
  }});
  const launch = await bridge.launch({app, presets, directory: dir, consent: true});
  assert.equal(launch.consumerVerified, false);
  assert.equal(bridge.session.rendererId, 'main');
  targets.replace([other, main]);
  assert.equal((await bridge.verifySession()).status, 'verification-pending');
  now = 1200;
  const slow = await bridge.verifySession();
  assert.equal(slow.status, 'verification-pending');
  assert.equal(slow.verificationReason, 'rendered-slider-mismatch');
  assert.equal(slow.consumerVerified, false);
  const after = await bridge.inspect();
  assert.equal(after.compatible, true);
  assert.notEqual(after.upgradeRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'adapter-check.json'))).status, 'configuration-applied');
  main.sync();
  now = 2400;
  assert.equal((await bridge.verifySession()).status, 'verification-pending');
  now = 3600;
  assert.equal((await bridge.verifySession()).status, 'consumer-verified');
  assert.deepEqual(observedIds, ['main', 'main', 'main', 'main']);
  assert.equal(other.client.updates, 0);
});
