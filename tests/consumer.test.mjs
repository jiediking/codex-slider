import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateConsumerObservation} from '../src/consumer.mjs';
import {saveAutomaticProof,applyAutomaticProof} from '../src/automatic.mjs';
const presets=Array.from({length:3},(_,i)=>({model:`test-model-${i}`,reasoning_effort:'high'}));
const rows=presets.map((p,i)=>({id:`stop-${i}`,model:p.model,reasoningEffort:p.reasoning_effort,powerSettingIndex:i}));
const dom={schemaVersion:1,source:'committed-slider-dom',status:'ready',defaultMode:true,interactive:true,rows,tickIds:rows.map(r=>r.id),optionIds:rows.map(r=>r.id),selected:rows[1],selectedIndex:1,selectionMode:'default',availablePairs:presets};
const picker={...dom,schemaVersion:2,source:'committed-slider-picker',contextRows:rows,contextSelection:{model:rows[1].model,reasoningEffort:'high'},triggerEffort:'high'};
test('matching DOM and closed-picker evidence confirms the selected ordered presets',()=>{for(const e of [dom,picker])assert.equal(validateConsumerObservation(e,presets).status,'matched');});
test('missing, loading, disabled and inconsistent evidence remains pending',()=>{
 for(const e of [null,{}, {status:'pending',reason:'loading'}, {...dom,interactive:false},{...dom,selectedIndex:0},{...dom,tickIds:[]},{...picker,triggerEffort:'xhigh'},{...picker,contextRows:[]}])assert.equal(validateConsumerObservation(e,presets).status,'pending');
});
test('stable supported mismatch differs from unavailable model evidence',()=>{
 const other=[presets[1],presets[0],presets[2]];
 assert.equal(validateConsumerObservation(dom,other).status,'mismatch');
 assert.equal(validateConsumerObservation({...dom,availablePairs:[]},[{model:'unavailable',reasoning_effort:'high'},...presets.slice(1)]).status,'pending');
});
test('readback and historical proofs never claim current-session consumer success',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'slider-proof-test-'));
 const app={compatible:true,appPath:'/synthetic/Codex.app',version:'test',build:'1',rendererSha256:'a'.repeat(64)};
 try {
  saveAutomaticProof(app,dir,'configuration-applied');
  const readback=applyAutomaticProof(app,dir);assert.equal(readback.configurationApplied,true);assert.equal(readback.consumerVerified,false);assert.equal(readback.requiresRuntimeCheck,true);
  saveAutomaticProof(app,dir,'consumer-verified',{observation:dom,presets});
  const historical=applyAutomaticProof(app,dir);assert.equal(historical.consumerPreviouslyVerified,true);assert.equal(historical.consumerVerified,false);assert.equal(historical.requiresRuntimeCheck,true);
  const file=path.join(dir,'adapter-check.json');const invalid=JSON.parse(fs.readFileSync(file));invalid.consumerEvidence.observation.selectedIndex=0;fs.writeFileSync(file,JSON.stringify(invalid));
  assert.deepEqual(applyAutomaticProof(app,dir),app);
  fs.rmSync(file);saveAutomaticProof(app,dir,'consumer-verified',{observation:{status:'pending'},presets});assert.equal(fs.existsSync(file),false);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
