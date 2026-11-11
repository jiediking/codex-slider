// Optional renderer adapter with a read-only probe of the actual client contract.
// No code runs on import. A user-initiated custom launch is required.
export function nativePresetAction(payload, operation = 'install') {
  const key = '__codexLocalPresetValidationV1';
  const configId = '423260384';
  const existing = globalThis[key];
  const snapshot = value => JSON.parse(JSON.stringify(value));
  const notify = client => client.$emt({name:'values_updated',
    ...(typeof client.loadingStatus === 'string' ? {status:client.loadingStatus} : {})});
  if (operation === 'inspect') {
    return {installed:!!existing, presets:existing ? snapshot(existing.presets) : null,
            consumerVerified:false,uiVerified:false, inferenceVerified:false};
  }
  if (operation === 'restore') {
    if (!existing) return {restored:true, wasInstalled:false};
    existing.client.getDynamicConfig = existing.original;
    delete globalThis[key];
    notify(existing.client);
    return {restored:true, wasInstalled:true, selectionReset:false};
  }
  if (operation !== 'install' && operation !== 'probe') return {installed:false, error:'Unsupported operation.'};
  const stops = payload && payload.presets;
  const efforts = new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);
  if (operation === 'install' && (!Array.isArray(stops) || stops.length !== 1 || !Array.isArray(stops[0]) ||
      stops[0].length < 3 || stops[0].length > 7 ||
      !stops[0].every(p => typeof p?.model === 'string' && p.model.length > 0 &&
                             efforts.has(p?.reasoning_effort)) ||
      new Set(stops[0].map(p => p.model + ':' + p.reasoning_effort)).size !== stops[0].length)) {
    return {installed:false, error:'Choose 3–7 distinct model and supported reasoning effort pairs.'};
  }
  const sdk = globalThis.__STATSIG__;
  // Statsig retains firstInstance even when a later client replaces the registered one.
  // A populated registry is authoritative; do not fall back to its stale predecessor.
  const registered = Object.values(sdk?.instances ?? {});
  const candidates = [...new Set(registered.length ? registered : [sdk?.firstInstance])];
  let changedSchema = false;
  const matches = candidates.filter(client => {
    if (!client || (client.loadingStatus !== undefined && client.loadingStatus !== 'Ready')) return false;
    if (typeof client.getDynamicConfig !== 'function' || typeof client.$emt !== 'function') {
      if (client.loadingStatus === 'Ready') changedSchema = true;
      return false;
    }
    try {
      const result = client.getDynamicConfig(configId, {disableExposureLog:true});
      const valid = typeof result?.get === 'function' && Array.isArray(result.value?.presets) &&
        result.value.presets.every(group => Array.isArray(group) && group.every(p =>
          typeof p?.model === 'string' && p.model.length > 0 &&
          typeof p?.reasoning_effort === 'string' && p.reasoning_effort.length > 0));
      if (!valid && client.loadingStatus === 'Ready' && result?.value &&
          Object.hasOwn(result.value,'presets') && result.value.presets != null) changedSchema = true;
      return valid;
    } catch { return false; }
  });
  if (matches.length !== 1) {
    if (matches.length > 1) return {installed:false, compatibility:'pending',error:'More than one slider configuration instance was found. No presets were applied.'};
    return {installed:false,compatibility:changedSchema ? 'incompatible':'pending',error:'The expected Codex configuration instance is not ready or its schema changed.'};
  }
  const client = matches[0];
  if (operation === 'probe') return {supported:true,compatibility:'interface-ready',consumerVerified:false,uiVerified:false,inferenceVerified:false};
  if (existing && existing.client !== client) {
    return {installed:false, error:'The Codex configuration instance changed. Quit Codex and try again.'};
  }
  const original = existing ? existing.original : client.getDynamicConfig;
  const upstream = original.call(client, configId, {disableExposureLog:true});
  if (!upstream || typeof upstream.value !== 'object' || !Array.isArray(upstream.value?.presets) ||
      typeof upstream.get !== 'function') {
    return {installed:false, error:'The slider configuration differs from the reviewed build.'};
  }
  const record = existing || {client, original, presets:null};
  record.presets = snapshot(stops[0]);
  if (!existing) {
    client.getDynamicConfig = function (id, ...args) {
      const result = original.call(this, id, ...args);
      if (id !== configId) return result;
      return {...result, value:{...result.value, presets:[snapshot(record.presets)]},
              get(name, fallback) {
                return name === 'presets' ? [snapshot(record.presets)] : result.get.call(result, name, fallback);
              }};
    };
    globalThis[key] = record;
  }
  try {
    notify(client);
    const actual=client.getDynamicConfig(configId,{disableExposureLog:true});
    if (JSON.stringify(actual?.value?.presets) !== JSON.stringify(stops) ||
        JSON.stringify(actual?.get?.('presets',null)) !== JSON.stringify(stops)) {
      client.getDynamicConfig=original;
      delete globalThis[key];
      return {installed:false,compatibility:'incompatible',error:'The applied presets could not be read back. The original method was restored.'};
    }
  } catch {
    client.getDynamicConfig = original;
    delete globalThis[key];
    return {installed:false, error:'The configuration update failed. The original method was restored.'};
  }
  return {installed:true, presets:snapshot(record.presets),readBackVerified:true,consumerVerified:false,uiVerified:false,inferenceVerified:false};
}
