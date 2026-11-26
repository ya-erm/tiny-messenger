import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {applyIdentityOperation,nextIdentityTime} from '../shared/identity-protocol.mjs';
import {appendReplication} from './replication.mjs';
import {HttpError} from './errors.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
export function tokenAttempt(body={}){
 const stable=body.operationId!==undefined||body.replacementToken!==undefined;
 if(stable&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.operationId)||!/^msg_[A-Za-z0-9_-]{16}$/.test(body.replacementToken)))throw new HttpError(422,'invalid_token_change','Некорректный запрос замены токена');
 if(body.changedAt!==undefined&&(typeof body.changedAt!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.changedAt)||!Number.isFinite(Date.parse(body.changedAt))))throw new HttpError(422,"invalid_token_change","Некорректное время операции");
 return {id:stable?body.operationId:randomUUID(),token:stable?body.replacementToken:'msg_'+randomBytes(12).toString('base64url')};
}
export function createIdentityService(database){
 return {
  async token(token,body){
   const attempt=tokenAttempt(body),oldHash=hash(token),newHash=hash(attempt.token);
   return database.transaction(async tx=>{
    const receipt=await tx.get('identity-operations',attempt.id);
    if(receipt){const user=await tx.get('users',receipt.userId);if(receipt.kind!=='token'||receipt.previousTokenHash!==oldHash||receipt.tokenHash!==newHash||user?.tokenHash!==newHash||body.changedAt!==undefined&&receipt.at!==body.changedAt)throw new HttpError(409,'token_change_conflict','Замена токена конфликтует с другой операцией');return {token:attempt.token};}
    const index=await tx.get('tokens',oldHash),user=index&&await tx.get('users',index.userId);if(!user||user.tokenHash!==oldHash)throw new HttpError(401,'invalid_token','Токен недействителен');
    if(body.changedAt&&Date.parse(body.changedAt)>Date.now()+300000)throw new HttpError(422,"invalid_token_change","Проверьте часы устройства");
    if(oldHash===newHash||await tx.get("tokens",newHash))throw new HttpError(409,"token_taken","Такой токен уже используется");
    const state=await tx.get('identity-state',user.id)||{},operation={version:1,id:attempt.id,userId:user.id,kind:'token',at:body.changedAt||nextIdentityTime(state.token),tokenHash:newHash,previousTokenHash:oldHash};
    await applyIdentityOperation(tx,operation);if((await tx.get("users",user.id)).tokenHash!==newHash)throw new HttpError(409,"token_change_conflict","Уже применена более новая замена токена");await appendReplication(tx,'identity:'+operation.id,{type:'identity',operation});return {token:attempt.token};
   });
  },
  async profile(actor,body){
   const clean=v=>typeof v==='string'?v.trim().replace(/\s+/g,' '):'';
   return database.transaction(async tx=>{
    const user=await tx.get('users',actor.id);if(!user||user.tokenHash!==actor.tokenHash)throw new HttpError(401,'invalid_token','Токен недействителен');
    const state=await tx.get('identity-state',user.id)||{},at=nextIdentityTime(state.profile),profile={name:clean(body.name),nickname:Object.hasOwn(body,'nickname')?(clean(body.nickname).replace(/^@/,'').toLowerCase()||null):(user.nickname||null),avatarUrl:clean(body.avatarUrl)||null,avatarBackground:Object.hasOwn(body,'avatarBackground')?(clean(body.avatarBackground)||null):(user.avatarBackground||null)};
    if(profile.nickname&&(await tx.scan('users',10001)).some(u=>u.id!==user.id&&u.nickname===profile.nickname))throw new HttpError(409,'nickname_taken','Этот ник уже занят');
    const claim=await tx.get('nickname-claims',user.id);const nicknameAt=(profile.nickname||null)===(user.nickname||null)?state.profile?.nicknameAt||claim?.at||user.createdAt:at;
    const operation={version:1,id:randomUUID(),userId:user.id,kind:'profile',at,nicknameAt,profile};
    try{await applyIdentityOperation(tx,operation);}catch(e){if(e.message.startsWith('Invalid'))throw new HttpError(422,'invalid_profile','Проверьте имя, ник и аватарку');throw e;}
    await appendReplication(tx,'identity:'+operation.id,{type:'identity',operation});await tx.addFeed(user.id,await tx.nextSequence(),{type:'snapshot.required'});return {user:await tx.get('users',user.id)};
   });
  },
  async import(operation){return database.transaction(tx=>applyIdentityOperation(tx,operation));},
 };
}
