import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import sharp from 'sharp';
import {createMobileServer} from '../../scripts/mobile-server.mjs';
import {unpackLibrary} from '../../scripts/mobile-archive.mjs';
import {createRelationalStore} from '../../scripts/relational-store.mjs';
import {DatabaseSync} from 'node:sqlite';
const password='synthetic-test-password-123';
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yixu-mobile-'));const salt=crypto.randomBytes(32).toString('hex');
  const config={origin:'http://127.0.0.1:12345',salt,passwordHash:crypto.scryptSync(password,salt,64).toString('hex'),dataDir:path.join(root,'data')};
  const controlDir=path.join(root,'control'),app=await createMobileServer({config,controlDir,backendPort:0,testHTTP:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${app.server.address().port}`;
  let cookie='',csrf='';
  const request=(route,{method='GET',data,bytes,headers={}}={})=>new Promise((resolve,reject)=>{
    const r=http.request(origin+route,{method,headers:{host:'127.0.0.1:12345',...(method==='POST'?{origin:config.origin,'content-type':bytes?'application/gzip':'application/json','x-yixu-csrf':csrf}:{}),...(cookie?{cookie}:{}),...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });r.on('error',reject);r.end(bytes||(data===undefined?undefined:JSON.stringify(data)));
  });
  async function login(){const r=await request('/mobile-api/login',{method:'POST',data:{password}});assert.equal(r.status,200,await r.clone().text());cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await(await request('/mobile-api/session')).json()).csrf;return r;}
  const post=(route,data)=>request('/mobile-api/'+route,{method:'POST',data});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,app,config,controlDir,request,post,login};
}
async function photo(){return (await sharp({create:{width:20,height:24,channels:3,background:'#123456'}}).jpeg().toBuffer()).toString('base64');}
const fields={name:'合成测试上衣',layer:'inner',subtype:'短袖T恤',colorName:'蓝色',hex:'#123456',family:'blue',seasons:['summer'],approved:true};
const library=async f=>(await(await f.request('/mobile-api/library')).json());
test('mobile boundary protects catalog, media and writes; checks session, host, origin and CSRF',async t=>{
  const f=await fixture(t);
  for(const route of ['/','/data/catalog.json','/assets/items/test.png','/__yixu_local/api/state','/__yixu_local/api/command'])assert.equal((await f.request(route)).status,401);
  const loginPage=await f.request('/login');assert.equal(loginPage.status,200);assert.match(await loginPage.text(),/mobile-login.js/);assert.equal((await f.request('/mobile-login.js')).status,200);
  const bad=await f.post('login',{password:'wrong'});assert.equal(bad.status,401);
  const success=await f.login();assert.match(success.headers.get('set-cookie'),/HttpOnly/);assert.match(success.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await f.post('garment',{...fields,photo:await photo()})).status,200);
  assert.equal((await f.request('/mobile-api/status',{method:'POST',data:{},headers:{'x-yixu-csrf':'wrong'}})).status,403);
  assert.equal((await f.request('/mobile-api/status',{method:'POST',data:{},headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await f.request('/mobile-api/library',{headers:{host:'evil.example'}})).status,403);
  assert.equal((await f.request('/__yixu_local/api/command',{method:'POST',data:{}})).status,404);
  assert.equal((await f.request('/__yixu_local/health')).status,404);
  await f.post('logout',{});assert.equal((await f.request('/mobile-api/library')).status,401);
});
test('mobile intake keeps registered originals, deduplicates, rejects invalid images and stale edits',async t=>{
  const f=await fixture(t);await f.login();const p=await photo();
  assert.equal((await f.post('garment',{...fields,photo:Buffer.from('<svg/>').toString('base64')})).status,400);
  assert.equal((await f.post('garment',{...fields,approved:false,photo:p})).status,400);
  let r=await f.post('garment',{...fields,photo:p});assert.equal(r.status,200,await r.clone().text());
  r=await f.post('garment',{...fields,photo:p});assert.equal((await r.json()).duplicate,true);
  let lib=await library(f);assert.equal(lib.catalog.items.length,1);const item=lib.catalog.items[0];assert.equal(item.provenance.processingMethod,'original-photo');assert.equal(item.material,null);
  const original=await f.request('/'+item.provenance.originalUrl);assert.equal(original.status,200);assert.equal(crypto.createHash('sha256').update(Buffer.from(await original.arrayBuffer())).digest('hex'),item.provenance.originalSha256);
  const edit={...fields,id:item.id,expected:lib.versions[item.id],name:'用户修改名称'};
  assert.equal((await f.post('garment',edit)).status,200);assert.equal((await f.post('garment',edit)).status,400);
  lib=await library(f);assert.equal(lib.catalog.items[0].name,'用户修改名称');
  const before=lib.versions[item.id];assert.equal((await f.post('status',{id:item.id,expected:before,status:'pending-discard'})).status,200);
  lib=await library(f);assert.equal(lib.catalog.items[0].wardrobeStatus,'pending-discard');assert.equal((await f.post('status',{id:item.id,expected:before,status:'active'})).status,400);
});
test('mobile outfit persistence, archive restore and rollback safeguards preserve records and media',async t=>{
  const f=await fixture(t);await f.login();await f.post('garment',{...fields,photo:await photo()});let lib=await library(f);const id=lib.catalog.items[0].id;
  let r=await f.post('outfit',{title:'合成搭配',selection:{inner:id},season:'summer',styleTags:['relaxed'],photo:await photo()});assert.equal(r.status,200,await r.clone().text());
  lib=await library(f);assert.equal(lib.state.data.outfits.length,1);assert.equal(lib.state.data.outfits[0].visual.kind,'photo');
  const archiveResponse=await f.post('backup',{});assert.equal(archiveResponse.status,200);const archive=Buffer.from(await archiveResponse.arrayBuffer());
  const parsed=JSON.parse(gunzipSync(archive));assert(parsed.files.some(x=>x.name.includes('original-')));assert(!parsed.files.some(x=>x.name.includes('config.json')));
  const preview=async()=>{const r=await f.request('/mobile-api/restore-preview',{method:'POST',bytes:archive});assert.equal(r.status,200,await r.clone().text());return r.json();};
  const p=await preview();assert.equal(p.garments,1);assert.equal(p.outfits,1);
  await f.post('garment',{...fields,id,expected:lib.versions[id],name:'备份之后修改'});
  assert.equal((await f.post('restore-apply',{token:p.token,confirm:'恢复'})).status,400);
  const p2=await preview();assert.equal((await f.post('restore-apply',{token:p2.token,confirm:'no'})).status,400);
  r=await f.post('restore-apply',{token:p2.token,confirm:'恢复'});assert.equal(r.status,200,await r.clone().text());
  lib=await library(f);assert.equal(lib.catalog.items[0].name,fields.name);assert.equal(lib.state.data.outfits.length,1);
  const safeguards=fs.readdirSync(path.join(f.controlDir,'before-restore'));assert.equal(safeguards.length,1);const db=new DatabaseSync(path.join(f.controlDir,'before-restore',safeguards[0],'wardrobe.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(db.prepare('SELECT data FROM garments').get().data).name,'备份之后修改');}finally{db.close();}
  assert(fs.existsSync(path.join(f.root,'data','wardrobe.sqlite')));assert.notEqual(JSON.parse(fs.readFileSync(path.join(f.controlDir,'config.json'))).dataDir,path.join(f.root,'data'));
  const outfit=lib.state.data.outfits[0];assert.equal((await f.post('remove-outfit',{id:outfit.id,expected:lib.versions[outfit.id]})).status,200);lib=await library(f);assert.equal(lib.state.data.outfits.length,0);assert.equal(lib.catalog.items.length,1);
});
test('restore rejects archive traversal, tampered database hashes and invalid SQLite without touching current data',async t=>{
  const f=await fixture(t);await f.login();await library(f);const archive=Buffer.from(await(await f.post('backup',{})).arrayBuffer());
  const bad=JSON.parse(gunzipSync(archive));bad.files.push({name:'public/../../escape',data:'eA==',sha256:crypto.createHash('sha256').update('x').digest('hex')});
  await assert.rejects(unpackLibrary(gzipSync(JSON.stringify(bad)),path.join(f.root,'invalid')));assert(!fs.existsSync(path.join(f.root,'escape')));
  const tampered=JSON.parse(gunzipSync(archive));tampered.files[0].data='eA==';await assert.rejects(unpackLibrary(gzipSync(JSON.stringify(tampered)),path.join(f.root,'invalid2')),/校验/);
  assert.equal((await library(f)).catalog.items.length,0);
});
test('login throttles repeated wrong passwords',async t=>{
  const f=await fixture(t);for(let i=0;i<8;i++)assert.equal((await f.post('login',{password:'wrong'})).status,401);assert.equal((await f.post('login',{password})).status,429);
});
