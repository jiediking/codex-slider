import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativePresetAction} from './native_hook.mjs';
import {observeSliderConsumer,validateConsumerObservation} from './consumer.mjs';
import {atomicJSON} from './core.mjs';

const runFile=promisify(execFile);
const adapterHash=crypto.createHash('sha256').update(nativePresetAction.toString()+observeSliderConsumer.toString()+validateConsumerObservation.toString()).digest('hex');
const requirement='=identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"';

async function archiveHash(file) {
  const digest=crypto.createHash('sha256');let size=0;
  const stream=fs.createReadStream(file,{signal:AbortSignal.timeout(15000)});
  for await(const bytes of stream) {
    if((size+=bytes.length)>2*1024*1024*1024) throw Error('Application archive is too large.');
    digest.update(bytes);
  }
  return digest.digest('hex');
}

// Eligibility is not a compatibility claim. Only a normal, consented custom
// launch can test the real configuration client. Never execute renderer files here.
export async function inspectAutomatic(app,{run=runFile,hash=archiveHash}={}) {
  if(!app.found||!app.appPath||app.upgradeRequired||app.compatible) return app;
  try {
    // Normal verification checks sealed code/resources. Strict detritus checks
    // would also reject harmless Finder metadata on an otherwise valid install.
    await run('/usr/bin/codesign',['--verify','--deep','--all-architectures','-R',requirement,app.appPath],
      {timeout:15000,maxBuffer:65536});
    const fingerprint=await hash(path.join(app.appPath,'Contents/Resources/app.asar'));
    return {...app,compatible:true,upgradeRequired:false,rendererSha256:fingerprint,
      compatibilityReason:'runtime-check-required',requiresRuntimeCheck:true,automaticStatus:'official-installation'};
  } catch {
    return {...app,upgradeRequired:false,automaticStatus:'unverified-installation'};
  }
}

function identity(app) {
  return {appPath:app.appPath,version:app.version,build:app.build,rendererSha256:app.rendererSha256,adapterHash};
}

export function applyAutomaticProof(app,directory,{retryFailed=false}={}) {
  if(!directory||!app.compatible) return app;
  try {
    const file=path.join(directory,'adapter-check.json'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384) return app;
    const proof=JSON.parse(fs.readFileSync(file,'utf8'));
    if(proof.schemaVersion!==2) return app;
    if(JSON.stringify(proof.identity)!==JSON.stringify(identity(app))) return app;
    if(proof.status==='configuration-applied') return {...app,configurationApplied:true,consumerVerified:false,
      requiresRuntimeCheck:true,compatibilityReason:'consumer-check-required'};
    if(proof.status==='consumer-verified'&&validateConsumerObservation(proof.consumerEvidence?.observation,
        proof.consumerEvidence?.presets).status==='matched')return {...app,configurationApplied:true,
      consumerPreviouslyVerified:true,consumerVerified:false,requiresRuntimeCheck:true,compatibilityReason:'consumer-previously-verified'};
    if(proof.status==='incompatible'&&!retryFailed) return {...app,compatible:false,upgradeRequired:true,
      compatibilityReason:'runtime-incompatible',requiresRuntimeCheck:false};
  } catch { /* Missing or corrupt local evidence requires another runtime check. */ }
  return app;
}

export function saveAutomaticProof(app,directory,status,consumerEvidence=null) {
  if(!directory||!['configuration-applied','incompatible','consumer-verified'].includes(status)) return;
  if(status==='consumer-verified'&&validateConsumerObservation(consumerEvidence?.observation,consumerEvidence?.presets).status!=='matched')return;
  try {atomicJSON(path.join(directory,'adapter-check.json'),{schemaVersion:2,identity:identity(app),status,
    ...(status==='consumer-verified'?{consumerEvidence}:{}),checkedAt:new Date().toISOString()});}
  catch { /* An unwritable record must not turn an applied session into a failure. */ }
}
