import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID,randomBytes,createHash}from'node:crypto';
import{memoryStore}from'./memory-store.mjs';import{createService}from'../src/service.mjs';import{applyIdentityOperation}from'../shared/identity-protocol.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');const attempt=()=>({operationId:randomUUID(),replacementToken:'msg_'+randomBytes(12).toString('base64url')});
async function fixture(){const db=memoryStore(),service=createService(db),registered=await service.registration.register({name:'User'},'192.0.2.1'),user=await service.authenticate(registered.token);return{db,service,registered,user};}
test('cloud rotates independently, accepts a lost response retry and never stores the clear credential',async()=>{
 const{db,service,registered,user}=await fixture(),body=attempt();await service.identity.token(registered.token,body);await assert.rejects(service.authenticate(registered.token),e=>e.status===401);assert.equal((await service.authenticate(body.replacementToken)).id,user.id);assert.equal((await service.identity.token(registered.token,body)).token,body.replacementToken);
 await assert.rejects(service.identity.token(registered.token,{...body,replacementToken:attempt().replacementToken}),e=>e.status===409);
 const saved=await db.transaction(async tx=>[await tx.get('identity-state',user.id),await tx.get('identity-operations',body.operationId),await tx.feed('@tm-replication-v1','0',100)]);assert.ok(!JSON.stringify(saved).includes(body.replacementToken));
 const latest=attempt();await service.identity.token(body.replacementToken,latest);await assert.rejects(service.identity.token(registered.token,body),e=>e.status===409);
});
test('profile and credential merge independently; stale directory and old events cannot restore a token',async()=>{
 const{db,service,registered,user}=await fixture(),stale={...user},body=attempt();await service.identity.token(registered.token,body);const rotated=await service.authenticate(body.replacementToken);
 await service.identity.profile(rotated,{name:'Renamed',nickname:'renamed'});await service.importDirectory({users:[stale],contacts:[],receipts:[]});assert.equal((await service.authenticate(body.replacementToken)).name,'Renamed');await assert.rejects(service.authenticate(registered.token),e=>e.status===401);
 const current=await db.transaction(tx=>tx.get('identity-state',user.id));await service.identity.import(current.token);const older={...current.token,id:randomUUID(),at:user.createdAt,tokenHash:hash('obsolete')};await service.identity.import(older);assert.equal((await service.authenticate(body.replacementToken)).id,user.id);
});
test('conflicting rotations converge in either order; a subsequent rotation supersedes both',async()=>{
 const a=await fixture(),b=memoryStore();await b.transaction(async tx=>{await tx.put('users',a.user.id,a.user);await tx.put('tokens',a.user.tokenHash,{userId:a.user.id})});const second=createService(b),x=attempt(),y=attempt();await a.service.identity.token(a.registered.token,x);await second.identity.token(a.registered.token,y);
 const left=(await a.db.transaction(tx=>tx.get('identity-state',a.user.id))).token,right=(await b.transaction(tx=>tx.get('identity-state',a.user.id))).token;
 await a.service.identity.import(right);await second.identity.import(left);assert.equal((await a.db.transaction(tx=>tx.get('users',a.user.id))).tokenHash,(await b.transaction(tx=>tx.get('users',a.user.id))).tokenHash);
 const winning=left.at+'|'+left.id>right.at+'|'+right.id?x.replacementToken:y.replacementToken,z=attempt();await a.service.identity.token(winning,z);const latest=(await a.db.transaction(tx=>tx.get('identity-state',a.user.id))).token;await second.identity.import(latest);assert.equal((await second.authenticate(z.replacementToken)).id,a.user.id);await assert.rejects(second.authenticate(winning),e=>e.status===401);
});
test('same nickname claimed while isolated converges without deleting either account',async()=>{
 const a=await fixture(),other=await a.service.registration.register({name:'Other'},'192.0.2.2');const one=await a.service.identity.profile(a.user,{name:'User',nickname:'same'}),state=await a.db.transaction(tx=>tx.get('identity-state',a.user.id));
 const operation={...state.profile,id:randomUUID(),userId:other.user.id,at:new Date(Date.parse(state.profile.at)+1).toISOString(),nicknameAt:new Date(Date.parse(state.profile.at)+1).toISOString()};await a.service.identity.import(operation);
 const users=await a.db.transaction(tx=>tx.scan('users',10));assert.equal(users.filter(u=>u.nickname==='same').length,1);assert.equal(users.length,2);assert.equal((await a.service.authenticate(other.token)).nickname,null);
});
