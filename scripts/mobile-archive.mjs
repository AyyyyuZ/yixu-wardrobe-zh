import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {backupPrivate} from './backup-private.mjs';
import {containedFile,databaseFile} from './data-paths.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export const archiveLimit=300*1024*1024;
export async function packLibrary(source,workspace){
  const snapshot=path.join(workspace,crypto.randomUUID());
  try{
    await backupPrivate(source,snapshot);
    const receipt=JSON.parse(fs.readFileSync(path.join(snapshot,'backup-receipt.json')));
    const names=['wardrobe.sqlite','backup-receipt.json',...receipt.files.map(f=>'public/'+f.path)];
    let total=0;
    const files=names.map(name=>{
      const bytes=fs.readFileSync(containedFile(snapshot,name));total+=bytes.length;
      if(total>150*1024*1024)throw Error('衣橱超过手机备份上限，请使用服务器完整备份工具');
      return {name,sha256:hash(bytes),data:bytes.toString('base64')};
    });
    return gzipSync(Buffer.from(JSON.stringify({format:'yixu-mobile-archive',version:1,files})));
  }finally{fs.rmSync(snapshot,{recursive:true,force:true});}
}
export async function unpackLibrary(bytes,target){
  if(bytes.length>archiveLimit||fs.existsSync(target))throw Error('恢复目录或文件大小无效');
  const archive=JSON.parse(gunzipSync(bytes,{maxOutputLength:archiveLimit}).toString('utf8'));
  if(archive.format!=='yixu-mobile-archive'||archive.version!==1||!Array.isArray(archive.files)||archive.files.length>20000)throw Error('不是支持的衣橱备份');
  const names=new Set();let total=0;
  fs.mkdirSync(target,{recursive:true,mode:0o700});
  try{
    for(const f of archive.files){
      if(typeof f.name!=='string'||names.has(f.name)||!(f.name==='wardrobe.sqlite'||f.name==='backup-receipt.json'||f.name.startsWith('public/'))||typeof f.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data))throw Error('备份文件清单无效');
      const to=containedFile(target,f.name),decoded=Buffer.from(f.data,'base64');total+=decoded.length;
      if(total>150*1024*1024||hash(decoded)!==f.sha256)throw Error('备份哈希或大小校验失败');
      names.add(f.name);fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});fs.writeFileSync(to,decoded,{flag:'wx',mode:0o600});
    }
    if(!names.has('wardrobe.sqlite')||!names.has('backup-receipt.json'))throw Error('备份缺少数据库或回执');
    const receipt=JSON.parse(fs.readFileSync(path.join(target,'backup-receipt.json')));
    if(receipt.format!=='yixu-private-backup'||receipt.version!==2)throw Error('备份回执无效');
    const db=new DatabaseSync(databaseFile(target),{readOnly:true});
    try{
      db.exec('PRAGMA trusted_schema=OFF');
      if(db.prepare('PRAGMA user_version').get().user_version!==2||db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('数据库完整性校验失败');
      const assets=db.prepare('SELECT relative_path,sha256 FROM media_assets').all();
      for(const asset of assets){const name='public/'+asset.relative_path;if(!names.has(name)||hash(fs.readFileSync(containedFile(target,name)))!==asset.sha256)throw Error('图片完整性校验失败');}
      const garments=db.prepare('SELECT COUNT(*) n FROM garments WHERE deleted_at IS NULL').get().n;
      const outfits=db.prepare('SELECT COUNT(*) n FROM outfits').get().n;
      return {garments,outfits,revision:Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get()?.value||0)};
    }finally{db.close();}
  }catch(e){fs.rmSync(target,{recursive:true,force:true});throw e;}
}
