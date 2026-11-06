import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
export const protocolError=(status,message)=>Object.assign(new Error(message),{status});
export function signProof(secret,kind,fields,ttl=60,now=Date.now()){
 if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw Error('Messenger integration key is not configured');
 const iat=Math.floor(now/1000),body=Buffer.from(JSON.stringify({...fields,v:1,kind,iat,exp:iat+ttl,nonce:randomBytes(24).toString('base64url')})).toString('base64url');
 return body+'.'+createHmac('sha256',secret).update('tasks-tm:v1:'+kind+':'+body).digest('base64url');
}
export function verifyProof(secret,kind,token,now=Date.now(),maxTTL=300){
 try{
  if(typeof secret!=='string'||Buffer.byteLength(secret)<32||typeof token!=='string'||token.length>4096)throw Error();
  const parts=token.split('.');if(parts.length!==2||parts.some(s=>!s||!/^[A-Za-z0-9_-]+$/.test(s)))throw Error();
  const expected=createHmac('sha256',secret).update('tasks-tm:v1:'+kind+':'+parts[0]).digest(),provided=Buffer.from(parts[1],'base64url');
  if(expected.length!==provided.length||!timingSafeEqual(expected,provided))throw Error();
  const p=JSON.parse(Buffer.from(parts[0],'base64url').toString()),at=Math.floor(now/1000);
  if(p.v!==1||p.kind!==kind||!Number.isInteger(p.iat)||!Number.isInteger(p.exp)||p.iat>at+5||p.exp<=at||p.exp<=p.iat||p.exp-p.iat>maxTTL||typeof p.nonce!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(p.nonce))throw Error();
  return p;
 }catch{throw protocolError(401,'Подтверждение Tiny Messenger недействительно или истекло.');}
}
export function identity(value){if(typeof value!=='string'||! /^(?:user-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))throw protocolError(400,'Неверный идентификатор учётной записи.');return value;}
