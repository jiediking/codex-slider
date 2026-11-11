import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {VERSION} from '../src/core.mjs';
import {validUpdateConfig,verifyEnvelope} from '../src/compatibility.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const run=(cmd,args)=>execFileSync(cmd,args,{cwd:root,stdio:'pipe'});
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const files=['app.mjs','package.json','compatibility-feed.json',...['src','web','scripts','tests'].flatMap(walk)];
for(const file of files){
 if(/\.(mjs|js)$/.test(file))run(process.execPath,['--check',file]);
 if(file.endsWith('.json'))JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
}
for(const file of files.filter(f=>f.endsWith('.py')))run('python3',['-c','import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())',file]);
for(const file of ['install.sh','scripts/install_macos.sh'])run('bash',['-n',file]);
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,VERSION);
const config=JSON.parse(fs.readFileSync(path.join(root,'src/compatibility-updates.json')));
assert(validUpdateConfig(config),'Invalid compatibility configuration');
for(const file of ['compatibility-feed.json','src/compatibility-signed.json'])verifyEnvelope(JSON.parse(fs.readFileSync(path.join(root,file))),config.publicKey);
const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');
for(const match of readme.matchAll(/\]\(([^)]+)\)|src="([^"]+)"/g)){
 const target=match[1]??match[2];if(/^[a-z]+:|^#/i.test(target))continue;
 const resolved=path.resolve(root,target.split('#')[0]);
 assert(resolved.startsWith(root)&&fs.statSync(resolved).isFile(),`Invalid local README reference: ${target}`);
}
console.log('Syntax, JSON, versions, compatibility signatures and local README references passed.');
