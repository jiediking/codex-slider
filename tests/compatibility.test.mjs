import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyEnvelope} from '../src/compatibility.mjs';
test('accept valid envelopes and reject tampering, wrong keys and malformed manifests',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const key=publicKey.export({type:'spki',format:'pem'});
 const manifest={schemaVersion:1,sequence:1,bundleId:'com.openai.codex',builds:[]};
 const envelope=value=>{const p=Buffer.from(JSON.stringify(value));return {payload:p.toString('base64'),signature:sign(null,p,privateKey).toString('base64')};};
 const valid=envelope(manifest);assert.deepEqual(verifyEnvelope(valid,key),manifest);
 assert.throws(()=>verifyEnvelope({...valid,payload:Buffer.from(JSON.stringify({...manifest,sequence:2})).toString('base64')},key));
 const other=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
 assert.throws(()=>verifyEnvelope(valid,other));
 for(const bad of [{}, {...valid,signature:'invalid'},envelope({...manifest,bundleId:'wrong'})])assert.throws(()=>verifyEnvelope(bad,key));
});
