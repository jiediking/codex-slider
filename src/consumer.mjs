// Serialized into a consented renderer session. Read-only: never touches the
// configuration SDK, hook record, callbacks, selections, text or account data.
export function observeSliderConsumer() {
  const pending=reason=>({schemaVersion:1,source:'committed-slider-dom',status:'pending',reason});
  const visible=node=>node?.isConnected===true && node.getClientRects().length>0 &&
    getComputedStyle(node).visibility==='visible' && getComputedStyle(node).display!=='none';
  const validString=value=>typeof value==='string'&&value.length>0&&value.length<=256;
  try {
    const controls=[...document.querySelectorAll('[data-reasoning-slider]')].filter(visible);
    if(controls.length>1)return pending('ambiguous-slider');
    // A closed popover has no slider/ticks. Its committed picker still consumes
    // the final stops and current selection, anchored to the visible trigger.
    const closedMenu=controls.length===0;
    const triggers=closedMenu?[...document.querySelectorAll('[data-selected-reasoning-effort]')].filter(visible):[];
    if(closedMenu&&triggers.length!==1)return pending(triggers.length?'ambiguous-slider':'open-model-menu');
    const control=closedMenu?triggers[0]:controls[0];
    const fiberKey=Object.getOwnPropertyNames(control).find(k=>k.startsWith('__reactFiber$'));
    let root=control[fiberKey];
    const ancestors=new Set();
    while(root?.return){
      if(ancestors.has(root)||ancestors.size>=2048)return pending('observer-limit');
      ancestors.add(root);root=root.return;
    }
    root=root?.tag===3?root.stateNode?.current:null;
    if(!root)return pending('observer-unavailable');
    // Walk only the current committed tree, never alternate/pending fibers.
    const parents=new Map(),nodes=[],stack=[[root,null]],seen=new Set();
    while(stack.length){
      const [node,parent]=stack.pop();
      if(!node)continue;
      if(seen.has(node)||seen.size>=30000)return pending('observer-limit');
      seen.add(node);parents.set(node,parent);nodes.push(node);
      if(node.sibling)stack.push([node.sibling,parent]);
      // React Offscreen hidden trees are mounted but not the visible control.
      if(node.tag!==22||node.memoizedState===null)if(node.child)stack.push([node.child,node]);
    }
    let current=nodes.find(n=>n.stateNode===control),owner=null,context=null,explicit,catalog=null,selectionMode=null,unavailable=[];
    if(!current)return pending('uncommitted-slider');
    for(let n=current;n;n=parents.get(n)){
      const p=n.memoizedProps;
      if(!owner&&Array.isArray(p?.powerSelections)&&typeof p.onSelectPower==='function')owner=n;
      if(owner&&n!==owner&&!context&&Array.isArray(p?.powerSelections)&&typeof p.onSelectModel==='function')context=p;
      if(typeof p?.isExplicitModelSelection==='boolean')explicit=p.isExplicitModelSelection;
      if(Array.isArray(p?.models)&&!catalog)catalog=p.models;
      if(typeof p?.selectionMode==='string')selectionMode=p.selectionMode;
      if(['hostId','executionHostId','permissionsHostId'].some(k=>typeof p?.[k]==='string'&&p[k]!=='local')||
        typeof p?.modelProvider==='string'&&p.modelProvider!=='openai')return pending('use-local-default-slider');
      if(Array.isArray(p?.modelOptions))unavailable.push(...p.modelOptions.filter(o=>o?.disabledReason!=null).map(o=>o.model?.model));
      if(p?.powerSelectionDisabled===true||p?.modelSelectionDisabled===true||p?.modelOptionsDisabled===true||
        p?.isModelSettingsLoading===true)return pending('selection-disabled');
    }
    if(!owner||explicit!==false)return pending('use-default-slider');
    const p=owner.memoizedProps,rows=p.powerSelections,selected=p.selectedPowerSelection;
    if(p.disabled===true||!closedMenu&&p.active!==true)return pending('selection-disabled');
    if(!Array.isArray(rows)||rows.length<3||rows.length>32||!selected)return pending('consumer-not-ready');
    if(rows.some(r=>!validString(r?.id)||!validString(r.model)||!validString(r.reasoningEffort)||
      !Number.isInteger(r.powerSettingIndex)||r.isLocked===true))return pending('consumer-not-ready');
    const row=r=>({id:r.id,model:r.model,reasoningEffort:r.reasoningEffort,powerSettingIndex:r.powerSettingIndex});
    const availablePairs=Array.isArray(catalog)&&catalog.length<=256?catalog.flatMap(m=>
      validString(m?.model)&&!unavailable.includes(m.model)&&Array.isArray(m.supportedReasoningEfforts)&&m.supportedReasoningEfforts.length<=16
        ?m.supportedReasoningEfforts.filter(e=>validString(e?.reasoningEffort)).map(e=>({model:m.model,reasoning_effort:e.reasoningEffort})):[]):[];
    if(closedMenu){
      if(p.open!==false||!context||context.open!==false||context.selectionMode!=='default')return pending('use-default-slider');
      if(context.disabled===true||control.disabled===true||control.getAttribute('aria-disabled')==='true')return pending('selection-disabled');
      if(context.powerSelections.length!==rows.length||context.powerSelections.some((r,i)=>!r||r.isLocked===true||
        JSON.stringify(row(r))!==JSON.stringify(row(rows[i]))))return pending('consumer-not-ready');
      const index=rows.findIndex(r=>r.id===selected.id),chosen=rows[index];
      const effort=control.getAttribute('data-selected-reasoning-effort');
      if(!chosen||JSON.stringify(row(chosen))!==JSON.stringify(row(selected))||context.model!==chosen.model||
        context.reasoningEffort!==chosen.reasoningEffort||effort!==chosen.reasoningEffort||
        current.memoizedProps?.['data-selected-reasoning-effort']!==effort)return pending('selection-not-ready');
      return {schemaVersion:2,source:'committed-slider-picker',status:'ready',defaultMode:true,interactive:true,
        rows:rows.map(row),contextRows:context.powerSelections.map(row),selected:row(chosen),selectedIndex:index,
        triggerEffort:effort,contextSelection:{model:context.model,reasoningEffort:context.reasoningEffort},availablePairs,selectionMode};
    }
    const under=(node,ancestor)=>{for(let n=node;n;n=parents.get(n))if(n===ancestor)return true;return false;};
    const drawings=nodes.filter(n=>under(n,owner)&&Array.isArray(n.memoizedProps?.options)&&
      typeof n.memoizedProps.onSelectOption==='function'&&validString(n.memoizedProps.selectedOptionId));
    if(drawings.length!==1)return pending('observer-unavailable');
    const drawing=drawings[0],d=drawing.memoizedProps;
    if(d.active!==true||d.disabled===true||d.options.some(o=>o.isLocked===true||o.requiresExplicitSelection===true))return pending('selection-disabled');
    const ticks=nodes.filter(n=>under(n,drawing)&&n.stateNode?.getAttribute&&
      n.memoizedProps?.style?.left!==undefined&&
      n.stateNode.hasAttribute('data-selected'));
    if(ticks.length!==d.options.length||ticks.some(n=>!visible(n.stateNode)))return pending('render-not-ready');
    const tickIds=ticks.map(n=>n.key),optionIds=d.options.map(o=>o.id);
    if(JSON.stringify(tickIds)!==JSON.stringify(optionIds))return pending('render-not-ready');
    if(ticks.some(n=>n.stateNode.getAttribute('data-locked')==='true'))return pending('selection-disabled');
    const ordered=optionIds.map(id=>rows.find(r=>r.id===id));
    if(ordered.some(r=>!r)||new Set(optionIds).size!==rows.length||ordered.length!==rows.length)return pending('render-not-ready');
    const index=optionIds.indexOf(d.selectedOptionId),chosen=rows.find(r=>r.id===selected.id);
    if(index<0||d.selectedOptionId!==selected.id||!chosen||chosen.model!==selected.model||
      chosen.reasoningEffort!==selected.reasoningEffort||chosen.powerSettingIndex!==selected.powerSettingIndex||ticks.some((n,i)=>
        n.stateNode.getAttribute('data-selected')!==String(i<=index)))return pending('selection-not-ready');
    return {schemaVersion:1,source:'committed-slider-dom',status:'ready',defaultMode:true,interactive:true,
      rows:ordered.map(row),tickIds,optionIds,selected:row(chosen),selectedIndex:index,availablePairs,selectionMode};
  } catch {return pending('observer-unavailable');}
}

// Host-side evidence validation. A renderer acknowledgement boolean is insufficient.
export function validateConsumerObservation(value,presets) {
  const pending={status:'pending',reason:value?.status==='pending'?value.reason:'invalid-evidence'};
  const dom=value?.schemaVersion===1&&value.source==='committed-slider-dom';
  const picker=value?.schemaVersion===2&&value.source==='committed-slider-picker';
  if((!dom&&!picker)||value.status!=='ready'||
    value.defaultMode!==true||value.interactive!==true)return pending;
  const {rows,tickIds,optionIds,selected,selectedIndex}=value;
  if(!Array.isArray(rows)||rows.length<3||rows.length>32||
    rows.some(r=>!r||typeof r.id!=='string'||typeof r.model!=='string'||typeof r.reasoningEffort!=='string'||
      !r.id||!r.model||!r.reasoningEffort||[r.id,r.model,r.reasoningEffort].some(s=>s.length>256)||
      !Number.isInteger(r.powerSettingIndex)))return pending;
  const ids=rows.map(r=>r.id);
  if(new Set(ids).size!==rows.length||!Number.isInteger(selectedIndex)||!selected||
    JSON.stringify(rows[selectedIndex])!==JSON.stringify(selected))return pending;
  if(dom&&(!Array.isArray(tickIds)||!Array.isArray(optionIds)||JSON.stringify(ids)!==JSON.stringify(tickIds)||
    JSON.stringify(ids)!==JSON.stringify(optionIds)))return pending;
  if(picker&&(value.selectionMode!=='default'||JSON.stringify(rows)!==JSON.stringify(value.contextRows)||
    value.contextSelection?.model!==selected.model||value.contextSelection?.reasoningEffort!==selected.reasoningEffort||
    value.triggerEffort!==selected.reasoningEffort))return pending;
  const actual=rows.map(r=>({model:r.model,reasoning_effort:r.reasoningEffort}));
  const matches=JSON.stringify(actual)===JSON.stringify(presets)&&rows.every((r,i)=>r.powerSettingIndex===i);
  if(!matches&&(value.selectionMode!=='default'||!Array.isArray(value.availablePairs)||!Array.isArray(presets)||
    !presets.every(p=>value.availablePairs.some(a=>a?.model===p.model&&a.reasoning_effort===p.reasoning_effort))))
    return {status:'pending',reason:'models-not-ready'};
  return {status:matches?'matched':'mismatch',fingerprint:JSON.stringify(rows),
    evidence:dom?{source:value.source,rows,tickIds,selected,selectedIndex,scope:'rendered-stops-and-current-selection'}:
      {source:value.source,rows,selected,selectedIndex,triggerEffort:value.triggerEffort,
        scope:'committed-picker-stops-and-visible-selection'}};
}
