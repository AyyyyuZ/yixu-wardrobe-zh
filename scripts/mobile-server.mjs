import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {createLocalServer,projectRoot} from './local-server.mjs';
import {dataDirectory,databaseFile,containedFile} from './data-paths.mjs';
import {packLibrary,unpackLibrary,archiveLimit} from './mobile-archive.mjs';
import {backupPrivate} from './backup-private.mjs';
import {garmentClassification} from '../dist/data/garment-taxonomy.js';
const scrypt=promisify(crypto.scrypt),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
const requireValue=(c,m)=>{if(!c)throw Error(m);};
const text=(v,max=120)=>{requireValue(typeof v==='string'&&v.trim().length>0&&v.length<=max,'文本字段无效');return v.trim();};
const token=()=>crypto.randomBytes(32).toString('hex');
async function body(request,limit){const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>limit){const e=Error('文件超过大小限制');e.status=413;throw e;}chunks.push(chunk);}return Buffer.concat(chunks);}
export async function createMobileServer({config,controlDir,backendPort=4184,testHTTP=false}={}){
  const publicURL=new URL(config.origin);
  if((publicURL.protocol!=='https:'&&!(testHTTP&&publicURL.hostname==='127.0.0.1'))||publicURL.origin!==config.origin)throw Error('公网入口必须为 HTTPS origin');
  fs.mkdirSync(controlDir,{recursive:true,mode:0o700});
  let currentDir=config.dataDir,backend,backendOrigin,switching=false;
  const sessions=new Map(),attempts=new Map(),restores=new Map();let queue=Promise.resolve();
  function exclusive(job){const result=queue.then(job);queue=result.catch(()=>{});return result;}
  async function startBackend(dir){const next=createLocalServer({dataDir:dir,databasePath:databaseFile(dir)});try{await listen(next,backendPort);backendOrigin=`http://127.0.0.1:${next.address().port}`;return next;}catch(e){await close(next);throw e;}}
  backend=await startBackend(currentDir);backendOrigin=`http://127.0.0.1:${backend.address().port}`;
  const call=async(resource,payload)=>{
    const response=await fetch(backendOrigin+'/__yixu_local/api/'+resource,{method:payload?'POST':'GET',headers:payload?{'content-type':'application/json','x-yixu-client':'3',origin:backendOrigin}:{},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(30000)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'衣橱服务读取失败');return result;
  };
  const command=command=>call('command',{command,requestId:crypto.randomUUID()});
  async function initialized(){const state=await call('state');if(!state.initialized)await call('migrate',{source:{key:null,raw:null}});}
  async function stage(url,bytes){const target=containedFile(path.join(currentDir,'public'),url);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});const root=fs.realpathSync(path.join(currentDir,'public'));if(!fs.realpathSync(path.dirname(target)).startsWith(root+path.sep))throw Error('图片目录无效');if(fs.existsSync(target)){if(!fs.readFileSync(target).equals(bytes))throw Error('图片不可覆盖');}else fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});return {url,sha256:sha(bytes)};}
  async function photo(base64){requireValue(typeof base64==='string'&&base64.length<=15*1024*1024&&/^[A-Za-z0-9+/]+={0,2}$/.test(base64),'请选择小于 10 MB 的 JPEG、PNG 或 WebP 图片');const bytes=Buffer.from(base64,'base64');requireValue(bytes.length<=10*1024*1024,'图片超过 10 MB');const image=sharp(bytes,{limitInputPixels:25e6,failOn:'warning'}),meta=await image.metadata();requireValue(['jpeg','png','webp'].includes(meta.format)&&(!meta.pages||meta.pages===1),'请使用 JPEG、PNG 或 WebP 静态照片；HEIC 请先转为 JPEG');const normalized=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).ensureAlpha().png().toBuffer();return {original:bytes,normalized,format:meta.format==='jpeg'?'jpg':meta.format};}
  function fields(p){const layer=p.layer;requireValue(['outer','inner','bottom','shoes','accessory'].includes(layer),'请选择类别');requireValue(/^#[a-f0-9]{6}$/i.test(p.hex),'颜色无效');requireValue(['green','red','blue','orange','yellow','purple','white','black','gray','brown','unknown'].includes(p.family),'请选择色系');const seasons=Array.isArray(p.seasons)?p.seasons:[];requireValue(seasons.every(s=>['spring','summer','autumn','winter'].includes(s)),'季节无效');return {name:text(p.name),layer,subtype:text(p.subtype),color:{name:text(p.colorName),family:p.family,hex:p.hex},seasons};}
  const staticFiles={'/login':['mobile-login.html','text/html; charset=utf-8'],'/manage':['mobile.html','text/html; charset=utf-8'],'/mobile-login.js':['mobile-login.js','text/javascript; charset=utf-8'],'/mobile.js':['mobile.js','text/javascript; charset=utf-8'],'/mobile.css':['mobile.css','text/css; charset=utf-8']};
  const server=http.createServer(async(req,res)=>{
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    const redirect=url=>{res.writeHead(303,{Location:url});res.end();};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      if(req.headers.host!==publicURL.host)return json(403,{error:'访问域名不匹配'});
      if(!req.url?.startsWith('/')||req.url.startsWith('//'))return json(400,{error:'地址无效'});
      const url=new URL(req.url,config.origin),route=url.pathname;
      const write=!['GET','HEAD'].includes(req.method);
      if(req.headers.origin&&req.headers.origin!==config.origin||req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'不允许跨站请求'});
      if(write&&(req.method!=='POST'||req.headers.origin!==config.origin))return json(403,{error:'请求来源无效'});
      const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('yixu_session='))?.slice(13);
      const session=cookie?sessions.get(sha(cookie)):null;
      const authenticated=session&&session.expires>Date.now();
      for(const [id,s] of sessions)if(s.expires<=Date.now())sessions.delete(id);
      for(const [id,s] of restores)if(s.expires<=Date.now()){fs.rmSync(s.dir,{recursive:true,force:true});restores.delete(id);}
      if(route==='/mobile-api/login'&&req.method==='POST'){
        if(req.headers['content-type']!=='application/json')return json(415,{error:'请求格式无效'});
        const ip=req.headers['x-real-ip']||req.socket.remoteAddress;const now=Date.now();
        for(const [id,a] of attempts)if(a.until<=now)attempts.delete(id);
        if(attempts.size>=1000&&!attempts.has(ip))return json(429,{error:'登录繁忙，请稍后再试'});
        const a=attempts.get(ip)||{count:0,until:now+15*60*1000};if(a.count>=8){res.setHeader('Retry-After',Math.ceil((a.until-now)/1000));return json(429,{error:'尝试过多，请 15 分钟后重试'});}a.count++;attempts.set(ip,a);
        const p=JSON.parse((await body(req,4096)).toString());if(typeof p.password!=='string'||p.password.length>200)return json(401,{error:'密码错误'});
        const derived=await scrypt(p.password,config.salt,64);if(!crypto.timingSafeEqual(derived,Buffer.from(config.passwordHash,'hex')))return json(401,{error:'密码错误'});
        if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
        const id=token(),csrf=token();sessions.set(sha(id),{csrf,expires:now+7*24*60*60*1000});attempts.delete(ip);
        res.setHeader('Set-Cookie',`yixu_session=${id}; HttpOnly; ${testHTTP?'':'Secure; '}SameSite=Strict; Path=/; Max-Age=604800`);return json(200,{ok:true});
      }
      if(staticFiles[route]&&['GET','HEAD'].includes(req.method)&&(route!=='/manage'||authenticated)){
        const [filename,type]=staticFiles[route];res.writeHead(200,{'Content-Type':type});return res.end(req.method==='HEAD'?'':fs.readFileSync(path.join(projectRoot,'dist',filename)));
      }
      if(!authenticated){if(req.method==='GET'&&req.headers.accept?.includes('text/html'))return redirect('/login');return json(401,{error:'请先登录'});}
      if(write&&req.headers['x-yixu-csrf']!==session.csrf)return json(403,{error:'页面已过期，请刷新后重试'});
      if(route==='/mobile-api/session'&&req.method==='GET')return json(200,{csrf:session.csrf});
      if(route==='/mobile-api/logout'&&req.method==='POST'){sessions.delete(sha(cookie));res.setHeader('Set-Cookie',`yixu_session=; Max-Age=0; Path=/; HttpOnly; ${testHTTP?'':'Secure; '}SameSite=Strict`);return json(200,{ok:true});}
      if(switching)return json(503,{error:'正在切换恢复副本，请稍后刷新'});
      if(route==='/mobile-api/library'&&req.method==='GET'){await queue;await initialized();const catalog=await call('catalog'),state=await call('state');return json(200,{catalog,state,versions:Object.fromEntries([...catalog.items,...state.data.outfits].map(r=>[r.id,sha(JSON.stringify(r))]))});}
      if(route==='/mobile-api/backup'&&req.method==='POST'){
        const bytes=await exclusive(()=>packLibrary(currentDir,path.join(controlDir,'snapshots')));res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="yixu-${new Date().toISOString().slice(0,10)}.yixu.gz"`});return res.end(bytes);
      }
      if(route==='/mobile-api/restore-preview'&&req.method==='POST'){
        requireValue(req.headers['content-type']==='application/gzip','请选择 .yixu.gz 备份');const bytes=await body(req,archiveLimit);
        return await exclusive(async()=>{requireValue(restores.size<3,'待恢复副本过多，请稍后重试');const id=token(),dir=path.join(controlDir,'restores',id);const summary=await unpackLibrary(bytes,dir);const before=await call('state');const candidate=createLocalServer({dataDir:dir,databasePath:databaseFile(dir)});try{await listen(candidate,0);const r=await fetch(`http://127.0.0.1:${candidate.address().port}/__yixu_local/api/catalog`);requireValue(r.ok,'恢复副本无法读取');await r.json();}finally{await close(candidate);}restores.set(id,{dir,summary,revision:before.revision,expires:Date.now()+30*60*1000,session:sha(cookie)});return json(200,{token:id,...summary});});
      }
      if(route.startsWith('/mobile-api/')&&req.method==='POST'){
        requireValue(req.headers['content-type']==='application/json','请求格式无效');const p=JSON.parse((await body(req,32*1024*1024)).toString());
        return await exclusive(async()=>{
          await initialized();
          if(route==='/mobile-api/restore-apply'){
            const restore=restores.get(p.token);requireValue(restore&&restore.session===sha(cookie)&&restore.expires>Date.now(),'恢复预览已过期');requireValue(p.confirm==='恢复','请输入“恢复”确认切换');requireValue((await call('state')).revision===restore.revision,'预览后衣橱已有修改，请重新上传备份预览');
            const safeguard=path.join(controlDir,'before-restore',crypto.randomUUID());await backupPrivate(currentDir,safeguard);
            const oldDir=currentDir;switching=true;await close(backend);
            try{backend=await startBackend(restore.dir);const updated={...config,dataDir:restore.dir};const file=path.join(controlDir,'config.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(updated,null,2),{mode:0o600});fs.renameSync(tmp,file);currentDir=restore.dir;config.dataDir=currentDir;restores.delete(p.token);}
            catch(e){if(backend?.listening)await close(backend);backend=await startBackend(oldDir);throw e;}
            finally{switching=false;}
            return json(200,{ok:true,message:'已切换到恢复副本；切换前完整备份和旧数据均已保留'});
          }
          if(route==='/mobile-api/garment'){
            const values=fields(p),catalog=await call('catalog');let previous,record,assets=[];
            if(p.id){previous=catalog.items.find(i=>i.id===p.id);requireValue(previous&&p.expected===sha(JSON.stringify(previous)),'衣物已改变，请刷新后重新编辑');record={...previous,...values,classification:previous.layer===values.layer&&previous.subtype===values.subtype?previous.classification:garmentClassification(values)};}
            else{
              requireValue(p.approved===true,'请先确认照片对应你拥有的这件衣物');const image=await photo(p.photo),originalHash=sha(image.original);
              const existing=catalog.items.find(i=>i.provenance?.originalSha256===originalHash);if(existing)return json(200,{ok:true,duplicate:true,id:existing.id,code:existing.code,message:'这张照片已录入，未重复添加'});
              const id='YW-M-'+crypto.randomUUID();
              const cutout=await stage(`assets/items/${id}/photo-${sha(image.normalized).slice(0,12)}.png`,image.normalized);
              // Original source is registered too, so portable backups retain it.
              const original=await stage(`assets/items/${id}/original-${originalHash.slice(0,12)}.${image.format}`,image.original);assets=[original,cutout];
              record={id,collection:'owned',...values,classification:garmentClassification(values),fit:'待确认',pattern:'待确认',styles:[],uncertainties:['面料、尺寸与合身度尚未确认'],material:null,warmth:null,createdAt:new Date().toISOString(),assets:{cutout:cutout.url},provenance:{kind:'mobile-photo',processingMethod:'original-photo',originalSha256:originalHash,originalRetained:true,originalUrl:original.url,cutoutSha256:cutout.sha256,review:{approved:true,notes:'用户确认上传照片对应真实拥有的衣物。展示图仅纠正方向和缩放，未去背景、未补全。'}}};
            }
            await command({type:'upsert-garment',record,expected:previous,assets});return json(200,{ok:true,id:record.id});
          }
          if(route==='/mobile-api/status'){
            const catalog=await call('catalog'),record=catalog.items.find(i=>i.id===p.id);requireValue(record&&p.expected===sha(JSON.stringify(record)),'衣物已改变，请刷新后重试');requireValue(['active','pending-discard'].includes(p.status),'状态无效');await command({type:'set-garment-status',records:[record],status:p.status});return json(200,{ok:true});
          }
          if(route==='/mobile-api/outfit'){
            const state=await call('state');const previous=p.id?state.data.outfits.find(o=>o.id===p.id):undefined;
            requireValue(!p.id||previous&&p.expected===sha(JSON.stringify(previous)),'搭配已改变，请刷新后重试');
            const record={...(previous||{}),id:previous?.id||'mobile-'+crypto.randomUUID(),title:text(p.title),selection:p.selection,createdAt:previous?.createdAt||new Date().toISOString(),season:p.season,styleTags:p.styleTags};
            if(p.photo){const image=await photo(p.photo),asset=await stage(`assets/outfits/mobile-${crypto.randomUUID()}.png`,image.normalized);await command({type:'register-assets',assets:[asset]});record.visual={src:asset.url,kind:'photo',alt:record.title,garmentIds:Object.values(p.selection)};}
            else if(record.visual)requireValue(JSON.stringify(record.selection)===JSON.stringify(previous.selection),'更换搭配衣物时请同时上传对应的新照片');
            await command({type:'upsert-owned-outfit',record,expected:previous});return json(200,{ok:true,id:record.id});
          }
          if(route==='/mobile-api/remove-outfit'){const state=await call('state'),record=state.data.outfits.find(o=>o.id===p.id);requireValue(record&&p.expected===sha(JSON.stringify(record)),'搭配已改变，请刷新后重试');await command({type:'remove-owned-outfits',records:[record]});return json(200,{ok:true});}
          return json(404,{error:'接口不存在'});
        });
      }
      // Internal mutation, migration, health and backup routes never reach the public proxy.
      const readable=['/state','/catalog','/references','/thumbnails'].some(s=>route==='/__yixu_local/api'+s);
      if(req.method!=='GET'&&req.method!=='HEAD'||route.startsWith('/__yixu_local/')&&!readable)return json(404,{error:'接口不存在'});
      const upstream=await fetch(backendOrigin+url.pathname+url.search,{method:req.method,signal:AbortSignal.timeout(30000)});
      for(const h of ['content-type','etag','content-length'])if(upstream.headers.has(h))res.setHeader(h,upstream.headers.get(h));
      // Existing wardrobe uses inline styles; its own CSP remains in effect after authentication.
      if(upstream.headers.has('content-security-policy'))res.setHeader('Content-Security-Policy',upstream.headers.get('content-security-policy'));
      res.writeHead(upstream.status);res.end(req.method==='HEAD'?'':Buffer.from(await upstream.arrayBuffer()));
    }catch(e){if(!res.headersSent)json(e.status||400,{error:e.message||'操作失败'});else res.destroy();}
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  return {server,close:async()=>{await queue;await close(server);await close(backend);},backendOrigin};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const controlDir=path.resolve(process.env.YIXU_MOBILE_CONTROL||path.join(dataDirectory(),'mobile-control'));
  const config=JSON.parse(fs.readFileSync(path.join(controlDir,'config.json'),'utf8'));
  const app=await createMobileServer({config,controlDir,backendPort:Number(process.env.YIXU_BACKEND_PORT||4184)});
  await listen(app.server,Number(process.env.YIXU_MOBILE_PORT||4185));
  console.log('手机衣橱已启动，公网入口：'+config.origin);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
