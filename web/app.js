(() => {
  'use strict';
  const root = document.getElementById('app');
  const validToken=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  let token=document.querySelector('meta[name="codex-slider-token"]').content;
  // Browser development launches receive the capability via a private opener
  // and a URL fragment (never sent to HTTP). Native startup supplies a header.
  try {
    const fragment=window.location?.hash?.match(/^#session=([a-f0-9]{64})$/)?.[1];
    if(fragment){token=fragment;window.history.replaceState(null,'',window.location.pathname+window.location.search);}
    if(!validToken(token))token=window.sessionStorage?.getItem('codex-slider-session');
    if(validToken(token))window.sessionStorage?.setItem('codex-slider-session',token);
  } catch { /* A native header remains sufficient when browser storage is blocked. */ }
  if(!validToken(token)){
    root.innerHTML='<div class="cs-stage"><div class="cs-window"><div class="cs-centered"><h2>Open Codex Slider to continue</h2><p>This editor needs a private session from the application. Reopen Slider to use your saved presets.</p></div></div></div>';
    return;
  }
  const state = {server: null, draft: [], selected: 0, stage: 'editor', error: '', pending: false,
    initialized: false, lastResult: null, allowLocalDebug: false, checkingCompatibility:false, compatibilityNotice:''};
  const effortNames = {low: 'Light', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra'};
  let pointerDrag = null;
  let dragFrame = null;
  let suppressPointerClick = false;
  let lastSnapshot = '';
  let closed = false;
  let verifying = false;
  let closing = false;
  let autoCloseTimer = null;
  let pollTimer = null;
  let polling = false;
  let pollRequested = false;
  let launchGeneration = 0;
  const desktop = window.__CODEX_SLIDER_DESKTOP__ === true;
  const notifyHost = type => {if (desktop) window.webkit?.messageHandlers?.sliderHost?.postMessage({type});};
  if (desktop) document.documentElement.classList.add('cs-desktop');
  const copy = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const mark = (name) => ({check: '✓', arrow: '↗', plus: '+', close: '×', grip: '⠿', info: 'ⓘ', local: '◫', spinner: '◌'}[name] ?? '');
  const modelByID = id => state.server?.catalog?.models.find(model => model.id === id);
  const effortName = id => Object.hasOwn(effortNames, id) ? effortNames[id] : (id ?? 'Choose effort');
  const modelName = id => modelByID(id)?.name ?? id ?? 'Choose model';
  const isDirty = () => !state.server?.saved || JSON.stringify(state.draft) !== JSON.stringify(state.server.presets);
  const sliderVerified = () => state.lastResult?.status==='consumer-verified'&&state.lastResult.applied===true&&
    state.server?.app.consumerVerified===true&&state.lastResult.consumerVerified===true&&
    state.lastResult.uiVerified===true&&['committed-slider-dom','committed-slider-picker'].includes(state.lastResult.consumerEvidence?.source);

  function cancelAutomaticClose() {
    if(autoCloseTimer!==null)clearTimeout(autoCloseTimer);
    autoCloseTimer=null;
  }

  function canAutomaticallyClose() {
    return desktop&&!closed&&!closing&&!state.pending&&!state.server?.busy&&!state.error&&
      state.stage==='done'&&sliderVerified()&&state.initialized&&!isDirty();
  }

  function scheduleAutomaticClose() {
    if(!canAutomaticallyClose()){cancelAutomaticClose();return;}
    if(autoCloseTimer!==null)return;
    const result=state.lastResult;
    autoCloseTimer=setTimeout(async()=>{
      autoCloseTimer=null;
      if(canAutomaticallyClose()&&state.lastResult===result)await closeTool(false);
    },1000);
  }

  function errors() {
    const messages = [];
    if (state.draft.length < 3 || state.draft.length > 7) messages.push('Keep between 3 and 7 presets.');
    const seen = new Set();
    state.draft.forEach((preset, index) => {
      const model = modelByID(preset?.model);
      if (!model) messages.push(`Preset ${index + 1}: choose an available model.`);
      else if (!model.efforts.some(effort => effort.id === preset.reasoning_effort)) messages.push(`Preset ${index + 1}: choose a supported effort.`);
      const pair = JSON.stringify([preset?.model, preset?.reasoning_effort]);
      if (seen.has(pair)) messages.push(`Preset ${index + 1}: each model and effort pair must be unique.`);
      seen.add(pair);
    });
    return messages;
  }

  async function api(route, body) {
    const response = await fetch(route, {method: body === undefined ? 'GET' : 'POST',
      headers: {'X-Codex-Slider-Token': token, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000)});
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error?.message ?? 'The operation could not be completed.');
      error.code = value.error?.code;
      throw error;
    }
    return value;
  }

  function receive(server, replaceDraft = false) {
    state.server = server;
    lastSnapshot = JSON.stringify(server);
    if (!state.initialized && server.catalog || replaceDraft) {
      state.draft = copy(server.presets).map(preset => ({model: preset?.model ?? '', reasoning_effort: preset?.reasoning_effort ?? ''}));
      state.initialized = true;
    }
    state.selected = Math.min(Math.max(0, state.selected), Math.max(0, state.draft.length - 1));
  }

  function primary(action, label, disabled = false) {
    return `<button class="cs-primary" type="button" data-action="${action}"${disabled ? ' disabled' : ''}>${escape(label)} <span aria-hidden="true">${mark('arrow')}</span></button>`;
  }

  function secondary(action, label) {
    return `<button class="cs-secondary" type="button" data-action="${action}">${escape(label)}</button>`;
  }

  const editPresets = () => '<button class="cs-text-button" type="button" data-action="edit">Edit presets</button>';

  function centered(title, description, body = '', actions = '') {
    const unconfirmed=state.stage==='done'&&['verification-pending','applied','adapter-incompatible'].includes(state.lastResult?.status);
    return `<section class="cs-centered" aria-live="polite"><div class="cs-status-icon${unconfirmed?' cs-status-unconfirmed':''}" aria-hidden="true">${mark(unconfirmed?'info':state.stage === 'done' ? 'check' : 'local')}</div><h2>${escape(title)}</h2><p>${escape(description)}</p>${body}<div class="cs-actions">${actions}</div></section>`;
  }

  function slider() {
    if (!state.draft.length) return '';
    const selected = state.draft[state.selected];
    return `<div class="cs-slider-box"><div class="cs-slider-title"><span>Slider preview</span><strong aria-live="polite">${escape(modelName(selected.model))} · ${escape(effortName(selected.reasoning_effort))}</strong></div>
      <input class="cs-range" type="range" min="0" max="${state.draft.length - 1}" value="${state.selected}" step="1" aria-label="Preview preset" aria-valuetext="Preset ${state.selected + 1}" data-control="slider">
      <div class="cs-stops">${state.draft.map((preset, index) => `<button class="cs-stop${index === state.selected ? ' is-selected' : ''}" type="button" data-action="select" data-index="${index}" aria-pressed="${index === state.selected}" aria-label="Preset ${index + 1} ${escape(modelName(preset.model))} ${escape(effortName(preset.reasoning_effort))}"><span class="cs-stop-name">${escape(modelName(preset.model).replace(/^GPT[- ]/, ''))}</span><span class="cs-stop-effort">${escape(effortName(preset.reasoning_effort))}</span></button>`).join('')}</div></div>`;
  }

  function options(index, field) {
    const preset = state.draft[index];
    const model = modelByID(preset.model);
    const entries = field === 'model' ? state.server.catalog.models.map(value => ({id: value.id, name: value.name})) :
      (model?.efforts ?? []).map(value => ({id: value.id, name: effortName(value.id)}));
    const selected = field === 'model' ? preset.model : preset.reasoning_effort;
    if (!entries.some(value => value.id === selected)) entries.unshift({id: selected, name: (selected || 'Choose ' + field) + ' (unavailable)'});
    return `<select class="cs-select cs-${field}" data-field="${field}" data-index="${index}" aria-label="Preset ${index + 1} ${field === 'model' ? 'model' : 'reasoning'}"${state.pending ? ' disabled' : ''}>${entries.map(value => `<option value="${escape(value.id)}"${value.id === selected ? ' selected' : ''}>${escape(value.name)}</option>`).join('')}</select>`;
  }

  function editor() {
    const server = state.server;
    const invalid = errors();
    const unsupported = !server.app.compatible;
    const compatibility = server.compatibility;
    const listMessage = server.app.automaticStatus === 'unverified-installation' ? 'The Codex installation could not be verified. Use an unmodified official copy and check again. Your presets are kept.' :
      server.app.compatibilityReason === 'resources-changed' ? 'This Codex installation differs from its reviewed compatibility record. Your presets are kept. Check for a matching signed list.' :
      compatibility?.status === 'error' ? compatibility.message :
      !compatibility?.configured ? 'Compatibility updates are not configured. Your presets are kept; open standard Codex or configure a signed compatibility source.' :
      compatibility.source === 'local' ? 'This Codex build is not in your local signed compatibility list. Import an updated signed list, then check again. An App upgrade is only needed for a new adapter.' :
      'The signed compatibility list does not cover this Codex build yet. Check again after the list is updated. Your presets are kept.';
    let warning = '';
    if (unsupported) warning = server.app.upgradeRequired
      ? '<div class="cs-warning">The current adapter does not support this Codex configuration. Update Codex Slider, or check compatibility again to retry. Your saved presets are kept.</div>'
      : `<div class="cs-warning">${escape(listMessage)}</div>`;
    else if (server.app.running) warning = '<div class="cs-warning">Reopen Codex to apply your saved presets.</div>';
    if (!unsupported && compatibility?.status === 'error' && !server.app.requiresRuntimeCheck) warning += `<div class="cs-warning">${escape(compatibility.message)}</div>`;
    const listStatus = server.app.compatibilityReason === 'consumer-check-required' ? 'Presets read back · slider effect not confirmed' :
      server.app.requiresRuntimeCheck ? 'Official Codex verified · configuration check on launch' : compatibility?.configured
      ? `${compatibility.source === 'local' ? 'Local signed list' : 'Online signed list'} · ${compatibility.status === 'ready' ? 'verified' : 'using saved data'}`
      : 'Compatibility updates are not configured';
    const checkControl = `<div class="cs-compatibility"><div><div class="cs-meta">${escape(listStatus)}</div>${state.compatibilityNotice ? `<div class="cs-check-result" role="status">${escape(state.compatibilityNotice)}</div>` : ''}</div><button type="button" class="cs-compatibility-button" data-action="check-compatibility" aria-busy="${state.checkingCompatibility}"${state.pending || server.busy ? ' disabled' : ''}>${state.checkingCompatibility ? 'Checking…' : unsupported ? 'Check compatibility again' : 'Check compatibility'}</button></div>`;
    const detected = server.app.version && server.app.build ? `Codex ${server.app.version} (${server.app.build})` : 'Codex found';
    const copyNotice = server.app.installationCount > 1 ? `<div class="cs-meta cs-installation">${server.app.installationCount} Codex copies found. Using ${escape(server.app.appPath)}.</div>` : '';
    const label = unsupported ? (invalid.length ? 'Open standard Codex' : 'Save & open standard Codex') :
      server.app.running ? (isDirty() ? 'Save & reopen Codex' : 'Reopen to apply') : (isDirty() ? 'Save & launch Codex' : 'Launch Codex');
    return `<div class="cs-content"><div class="cs-heading"><div><h2>Customize Codex’s Default Slider</h2><div class="cs-meta">${escape(detected)} · Signed in · ${server.catalog.models.length} models</div>${copyNotice}</div><span class="cs-count">${state.draft.length} presets</span></div>${warning}${checkControl}${slider()}
      <div class="cs-list-heading"><strong>All presets</strong><span>Drag to reorder</span></div>
      <div class="cs-columns"><span></span><span>Model</span><span>Reasoning</span><span></span></div>
      <div class="cs-rows">${state.draft.map((preset, index) => `<div class="cs-row${index === state.selected ? ' is-selected' : ''}" data-drop-index="${index}"><button type="button" class="cs-grip" data-drag-index="${index}" data-action="select" data-index="${index}" aria-label="Preset ${index + 1} order. Use the up and down arrow keys to move."><span aria-hidden="true">${mark('grip')}</span><span>${index + 1}</span></button>${options(index, 'model')}${options(index, 'effort')}<button class="cs-icon-button" type="button" data-action="remove" data-index="${index}" aria-label="Remove preset ${index + 1}"${state.draft.length <= 3 || state.pending ? ' disabled' : ''}>${mark('close')}</button></div>`).join('')}</div>
      <div class="cs-add-row"><button class="cs-text-button" type="button" data-action="add"${state.draft.length >= 7 || state.pending ? ' disabled' : ''}>+ Add preset</button><span class="cs-subnote">3–7 presets</span></div>
      <div class="cs-validation" role="alert">${escape(invalid[0] ?? '')}</div></div>
      <div class="cs-footer"><div class="cs-save-state">${mark(isDirty() ? 'info' : 'check')} ${isDirty() ? (server.saved ? 'Unsaved changes' : 'Ready when you are') : 'Presets saved'}</div>${primary('launch', label, state.pending || Boolean(invalid.length && !unsupported))}</div>`;
  }

  function content() {
    const server = state.server;
    if (state.stage === 'closed') return centered('Codex Slider is closed', 'Open Codex Slider to use the tool again.');
    if (!server || server.account === 'loading' || server.busy && !state.initialized && !state.pending) return centered('Reading your models', 'Checking your local Codex installation.');
    if (server.storageError) return centered('Your settings need attention', server.storageError, '', secondary('settings', 'Open settings folder') + secondary('refresh', 'Check again'));
    if (!server.app.found) return centered('Install Codex to get started', 'Codex Slider uses your installed Codex desktop app and its ChatGPT sign-in.', '', '<a class="cs-secondary cs-secondary-link" href="https://chatgpt.com/download" target="_blank" rel="noopener noreferrer">Get Codex</a>' + primary('refresh', 'Check again'));
    if (server.account === 'signed-out') return centered('Sign in to see your models', 'Sign in with ChatGPT in Codex, then come back here.', '', secondary('signin', 'Open Codex to sign in') + primary('refresh', 'I’m signed in — check again'));
    if (server.account === 'error') return centered('Your models could not be loaded', server.error ?? 'Try checking again.', '', secondary('signin', 'Open Codex') + primary('refresh', 'Try again'));
    if (state.stage === 'consent') return centered('Enable your custom slider', 'Launch Codex from this tool to apply your saved presets.', '<div class="cs-permission"><p>This opens a local debugging connection. Local apps can inspect or change Codex while it is open. Use this only on a trusted Mac.</p><p>Fully quit Codex to close the connection; closing Slider does not close it. Slider exits after confirming your presets.</p></div>', secondary('edit', 'Back to editing') + primary('accept', 'Enable & launch'));
    if (state.stage === 'needs-quit') return centered('Reopen to apply presets', 'Finish your current work in Codex, then press ⌘Q to quit.', `<span class="cs-current-tag">${mark('check')} ${state.draft.length} presets saved</span>`, secondary('edit', 'Later') + primary('continue', 'I’ve quit Codex — continue'));
    if (state.stage === 'opening') return centered('Opening Codex', '', `<div class="cs-progress-label" role="status"><span class="cs-spinner" aria-hidden="true">${mark('spinner')}</span>${escape(server.phase || 'Checking your saved presets')}</div>`);
    if (state.stage === 'done') {
      const result=state.lastResult;
      if(sliderVerified()) {
        return centered('Your slider is ready','Codex’s slider presets, models, reasoning levels, order and current selection match your settings.',
          `<div class="cs-meta" role="status">Verified in this Codex session${desktop?' · Closing Slider automatically…':''}</div>`,editPresets()+primary('signin','Go to Codex'));
      }
      if(result?.status==='adapter-incompatible')return centered('This slider needs an updated adapter',
        'Codex rendered a stable slider that differs from your presets. Update Slider or check compatibility again. Your presets are saved.',
        '<div class="cs-meta" role="status">Slider did not match</div>',editPresets()+primary('check-compatibility','Check compatibility again'));
      if (result?.status === 'verification-pending' || result?.status === 'applied') {
        const observerError=['observer-unavailable','observer-limit','invalid-evidence','ambiguous-slider'].includes(result.verificationReason);
        const detail=['session-changed','no-owned-session'].includes(result.verificationReason)
          ? 'This Codex session changed. Save your work, quit Codex normally, and launch it through Slider again to verify.'
          : observerError
          ? 'Slider could not read Codex’s current slider. Your presets are saved. Check again to retry.'
          : result.configurationApplied && result.readBackVerified
          ? 'Slider is checking Codex’s Default slider automatically and will close after confirmation. If this stays unconfirmed, open Codex’s model menu.'
          : 'Codex opened. Check the actual slider before relying on your presets.';
        return centered('Check your slider in Codex',detail,
          '<div class="cs-meta" role="status">Slider effect not confirmed</div>',
          editPresets()+primary(observerError?'verify-slider':'signin',observerError?'Check again':'Go to Codex'));
      }
      const description=result?.status === 'already-running' ? 'Codex was already running. Its current session is still open.' : 'Codex opened with its standard slider.';
      return centered('Codex is open',description,'',secondary('edit','Edit presets')+primary('signin','Go to Codex'));
    }
    if (state.stage === 'close-confirm') return centered('Save your changes?', 'Your edits have not been saved yet.', '', secondary('edit', 'Keep editing') + secondary('discard-close', 'Discard & close') + primary('save-close', 'Save & close', errors().length > 0));
    return editor();
  }

  function render() {
    const label = state.server?.testMode ? 'Offline test session' : 'Local';
    const version = state.server?.version ? `<span class="cs-version">v${escape(state.server.version)}</span>` : '';
    root.innerHTML = `<div class="cs-stage"><div class="cs-window"><header class="cs-chrome"><div class="cs-brand"><span class="cs-brand-mark" aria-hidden="true">☷</span>Codex Slider ${version}</div><div class="cs-local"><span class="${state.server?.testMode ? 'cs-test' : ''}">${escape(label)}</span><button type="button" class="cs-icon-button cs-close" data-action="close" aria-label="Close tool"${state.pending || state.server?.busy ? ' disabled' : ''}>×</button></div></header>${state.error ? `<div class="cs-content"><div class="cs-alert" role="alert">${escape(state.error)}</div></div>` : ''}${content()}</div></div>`;
    scheduleAutomaticClose();
  }

  async function refresh() {
    if (state.pending) return;
    state.pending = true;
    state.error = '';
    try { receive(await api('/api/refresh', {})); state.stage = 'editor'; }
    catch (error) { state.error = error.message; }
    finally { state.pending = false; render(); }
  }

  async function checkCompatibility() {
    if (state.pending) return;
    state.pending=true;state.checkingCompatibility=true;state.compatibilityNotice='';state.error='';
    render();
    try {
      receive(await api('/api/compatibility/check',{}));
      if(state.server.lastLaunch)state.lastResult=state.server.lastLaunch;
      const server=state.server;
      const detected=`Codex ${server.app.version ?? 'unknown'} (${server.app.build ?? 'unknown'})`;
      state.compatibilityNotice=server.app.consumerVerified===true
        ? `Codex’s slider verified for ${detected} in this session.`
        : server.app.compatibilityReason === 'consumer-check-required'
        ? `Presets were read back for ${detected}. Their actual slider effect is not confirmed.`
        : server.app.requiresRuntimeCheck
        ? `Official ${detected} verified. Launch to apply presets, then check the slider in Codex.`
        : server.compatibility?.status === 'error'
        ? 'Could not update the list. Saved compatibility data is kept.'
        : server.app.compatible ? `Reviewed compatibility record matched for ${detected}. The actual slider effect still needs checking.`
        : server.app.upgradeRequired ? 'This build needs a newer Slider adapter.'
        : `No reviewed compatibility entry for ${detected} in the latest verified list.`;
    } catch (error) {state.error=error.message;}
    finally {state.pending=false;state.checkingCompatibility=false;render();}
  }

  async function verifySlider() {
    if(closed||verifying||state.pending||state.stage!=='done'||state.lastResult?.status!=='verification-pending')return;
    const generation=launchGeneration;
    verifying=true;
    try {
      const value=await api('/api/verification/check',{});
      if(closed||generation!==launchGeneration)return;
      receive(value.state);state.lastResult=value.result;render();
    } catch { /* A delayed observation stays unconfirmed; polling can retry. */ }
    finally {verifying=false;}
  }

  async function launch(standard = false) {
    if (state.pending) return;
    launchGeneration++;
    state.pending = true;
    state.error = '';
    state.stage = 'opening';
    render();
    try {
      const value = await api('/api/launch', {presets: state.draft, revision: state.server.revision,
        allowLocalDebug: state.allowLocalDebug, standard});
      receive(value.state, value.result.status !== 'already-running' && !standard);
      state.lastResult = value.result;
      state.stage = value.result.status === 'needs-quit' ? 'needs-quit' : 'done';
    } catch (error) {
      state.error = error.message;
      state.stage = error.code === 'CONSENT_REQUIRED' ? 'consent' : 'editor';
      try { receive(await api('/api/state')); } catch { /* Keep the draft if the server is unavailable. */ }
    } finally {
      state.pending = false; render();
      if(state.stage==='done'&&state.lastResult?.status==='verification-pending')requestPoll(0);
    }
  }

  function move(from, to) {
    if (state.pending || to < 0 || to >= state.draft.length || from === to) return;
    const [preset] = state.draft.splice(from, 1);
    state.draft.splice(to, 0, preset);
    state.selected = to;
  }

  async function closeTool(save) {
    if(closed||closing)return;
    closing=true;cancelAutomaticClose();state.pending=true;render();
    try {
      if (save) receive(await api('/api/save', {presets: state.draft, revision: state.server.revision}), true);
      await api('/api/close', {});
      state.stage = 'closed'; closed = true; state.error = '';
      notifyHost('closed');
    } catch (error) { state.error = error.message; state.stage = 'editor'; }
    finally {state.pending=false;closing=false;render();}
  }

  function requestClose() {
    if (closed) {notifyHost('closed'); return;}
    if (state.pending || state.server?.busy) {
      state.error = 'Please wait for the current operation to finish before closing.';
      render(); return;
    }
    if (state.initialized && isDirty()) {state.stage = 'close-confirm'; render();}
    else closeTool(false);
  }

  if (desktop) window.codexSliderDesktop = Object.freeze({requestClose});

  root.addEventListener('change', event => {
    const target = event.target;
    if (state.pending) return;
    if (target.dataset.control === 'slider') {state.selected = Number(target.value); render(); return;}
    if (!target.dataset.field) return;
    const index = Number(target.dataset.index);
    if (target.dataset.field === 'model') {
      const model = modelByID(target.value);
      if (!model) return;
      state.draft[index] = {model: model.id, reasoning_effort: model.defaultEffort};
    } else state.draft[index].reasoning_effort = target.value;
    state.selected = index;
    render();
  });

  root.addEventListener('input', event => {
    if (event.target.dataset.control !== 'slider') return;
    state.selected = Number(event.target.value);
    const preset = state.draft[state.selected];
    root.querySelector('.cs-slider-title strong').textContent = modelName(preset.model) + ' · ' + effortName(preset.reasoning_effort);
    root.querySelectorAll('.cs-stop').forEach((button, index) => {
      button.classList.toggle('is-selected', index === state.selected);
      button.setAttribute('aria-pressed', String(index === state.selected));
    });
  });

  root.addEventListener('click', async event => {
    if (suppressPointerClick && event.detail > 0) return;
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled || state.pending) return;
    const action = button.dataset.action;
    const index = Number(button.dataset.index);
    if (action === 'select') state.selected = index;
    else if (action === 'remove' && state.draft.length > 3) {state.draft.splice(index, 1); state.selected = Math.min(state.selected, state.draft.length - 1);}
    else if (action === 'add' && state.draft.length < 7) {
      const used = new Set(state.draft.map(preset => preset.model + '/' + preset.reasoning_effort));
      let next;
      for (const model of state.server.catalog.models) {
        const effort = [model.defaultEffort, ...model.efforts.map(value => value.id)].find(value => !used.has(model.id + '/' + value));
        if (effort) {next = {model: model.id, reasoning_effort: effort}; break;}
      }
      if (next) {state.draft.push(next); state.selected = state.draft.length - 1;}
    } else if (action === 'refresh') {await refresh(); return;}
    else if (action === 'check-compatibility') {await checkCompatibility(); return;}
    else if (action === 'verify-slider') {await verifySlider(); return;}
    else if (action === 'launch') {
      if (!state.server.app.compatible) {await launch(true); return;}
      if (!state.server.consent) state.stage = 'consent';
      else {await launch(); return;}
    } else if (action === 'accept') {state.allowLocalDebug = true; await launch(); return;}
    else if (action === 'continue') {await launch(); return;}
    else if (action === 'edit') {state.stage = 'editor'; state.error = '';}
    else if (action === 'close') {
      requestClose(); return;
    } else if (action === 'discard-close' || action === 'save-close') {await closeTool(action === 'save-close'); return;}
    else if (action === 'signin' || action === 'settings') {
      try {await api(action === 'settings' ? '/api/open-settings' : '/api/open-codex', {});}
      catch (error) {state.error = error.message;}
    }
    render();
  });

  root.addEventListener('keydown', event => {
    const grip = event.target.closest('[data-drag-index]');
    if (!grip) return;
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault(); state.selected = Number(grip.dataset.dragIndex); render();
      root.querySelector(`[data-drag-index="${state.selected}"]`).focus(); return;
    }
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    move(Number(grip.dataset.dragIndex), Number(grip.dataset.dragIndex) + (event.key === 'ArrowUp' ? -1 : 1));
    render();
    root.querySelector(`[data-drag-index="${state.selected}"]`).focus();
  });

  // Pointer capture keeps ordering inside the editor across browser and native WebView.
  function updatePointerDrag() {
    if (!pointerDrag) return;
    if (pointerDrag.moved) {
      const content = root.querySelector('.cs-content');
      if (content) {
        const bounds = content.getBoundingClientRect();
        if (pointerDrag.y > bounds.bottom - 32) content.scrollTop += 9;
        else if (pointerDrag.y < bounds.top + 32) content.scrollTop -= 9;
      }
      const row = document.elementFromPoint(pointerDrag.x, pointerDrag.y)?.closest('[data-drop-index]');
      pointerDrag.to = row && root.contains(row) ? Number(row.dataset.dropIndex) : null;
      root.querySelectorAll('[data-drop-index]').forEach(node => {
        node.classList.toggle('is-drop', Number(node.dataset.dropIndex) === pointerDrag.to);
        node.classList.toggle('is-dragging', Number(node.dataset.dropIndex) === pointerDrag.from);
      });
    }
    dragFrame = requestAnimationFrame(updatePointerDrag);
  }

  root.addEventListener('pointerdown', event => {
    const grip = event.target.closest('[data-drag-index]');
    if (!grip || state.pending || event.button !== 0) return;
    event.preventDefault();
    grip.focus();
    pointerDrag = {id: event.pointerId, from: Number(grip.dataset.dragIndex), to: null,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false};
    root.setPointerCapture(event.pointerId);
    dragFrame = requestAnimationFrame(updatePointerDrag);
  });
  root.addEventListener('pointermove', event => {
    if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
    pointerDrag.x = event.clientX; pointerDrag.y = event.clientY;
    if (Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) > 5) pointerDrag.moved = true;
  });
  function endPointerDrag(event) {
    if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
    const drag = pointerDrag;
    const dropRow = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop-index]');
    drag.to = dropRow && root.contains(dropRow) ? Number(dropRow.dataset.dropIndex) : null;
    pointerDrag = null;
    cancelAnimationFrame(dragFrame);
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    const scroll = root.querySelector('.cs-content')?.scrollTop ?? 0;
    if (event.type === 'pointerup') {
      if (drag.moved && drag.to !== null) move(drag.from, drag.to);
      else if (!drag.moved) state.selected = drag.from;
      suppressPointerClick = true;
      setTimeout(() => {suppressPointerClick = false;}, 0);
    }
    render();
    const content = root.querySelector('.cs-content');
    if (content) content.scrollTop = scroll;
    root.querySelector(`[data-drag-index="${state.selected}"]`)?.focus({preventScroll: true});
  }
  root.addEventListener('pointerup', endPointerDrag);
  root.addEventListener('pointercancel', endPointerDrag);
  root.addEventListener('lostpointercapture', endPointerDrag);

  window.addEventListener('beforeunload', event => {
    if (!closed && state.initialized && isDirty()) {event.preventDefault(); event.returnValue = '';}
  });

  function requestPoll(delay) {
    if(closed)return;
    if(polling){pollRequested=true;return;}
    if(pollTimer!==null)clearTimeout(pollTimer);
    pollTimer=setTimeout(poll,delay);
  }

  async function poll() {
    if (closed) return;
    if(polling){pollRequested=true;return;}
    pollTimer=null;polling=true;
    try {
      const server = await api('/api/state');
      if (closed) return;
      const changed = lastSnapshot !== JSON.stringify(server);
      receive(server);
      if(state.stage==='done'&&state.lastResult?.status==='verification-pending')await verifySlider();
      if (changed) render();
    } catch {
      if (closed) return;
      state.error = 'The local tool is no longer available. Reopen Codex Slider to try again. Your current edits are still shown here.';
      render();
    } finally {
      polling=false;
      const delay=pollRequested?0:state.server?.busy||state.pending||!state.initialized||state.lastResult?.status==='verification-pending'?1500:15000;
      pollRequested=false;requestPoll(delay);
    }
  }
  render();
  poll();
  notifyHost('ready');
})();
