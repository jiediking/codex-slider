import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCatalog,validatePresets} from '../src/core.mjs';
const catalog=normalizeCatalog({models:Array.from({length:8},(_,i)=>({model:`test-model-${i}`,supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]}))});
const pairs=Array.from({length:8},(_,i)=>({model:`test-model-${i}`,reasoning_effort:'high'}));
test('accept 3 and 7 presets and preserve order',()=>{for(const n of [3,7]){const p=pairs.slice(0,n).reverse();assert.deepEqual(validatePresets(p,catalog),p);}});
test('reject invalid counts, duplicate pairs and unavailable choices',()=>{
 for(const p of [pairs.slice(0,2),pairs,[pairs[0],pairs[0],pairs[1]],[...pairs.slice(0,2),{model:'missing',reasoning_effort:'high'}],[...pairs.slice(0,2),{model:'test-model-2',reasoning_effort:'unknown'}]])assert.throws(()=>validatePresets(p,catalog));
});
test('same model with different reasoning levels is valid',()=>{const p=[pairs[0],{...pairs[0],reasoning_effort:'xhigh'},pairs[1]];assert.deepEqual(validatePresets(p,catalog),p);});
test('incomplete and invalid catalogs fail',()=>{for(const c of [{models:[],nextCursor:'more'},{models:[]},{models:[{},{}]}])assert.throws(()=>normalizeCatalog(c));});
