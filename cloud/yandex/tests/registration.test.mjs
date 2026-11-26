import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID,randomBytes,createHash}from'node:crypto';
import{memoryStore}from'./memory-store.mjs';import{createService}from'../src/service.mjs';
const body=(name='Cloud',nickname='')=>({name,nickname,clientRequestId:randomUUID(),registrationToken:'msg_'+randomBytes(12).toString('base64url')});
test('registration is anonymous, durable, replayable and journals no raw credential',async()=>{
 const db=memoryStore(),service=createService(db),request=body('Independent','independent');
 const first=await service.registration.register(request,'192.0.2.1');assert.equal(first.token,request.registrationToken);assert.equal(first.user.id,request.clientRequestId);assert.ok(!('tokenHash'in first.user));assert.equal((await service.registration.register(request,'192.0.2.1')).replayed,true);
 await assert.rejects(service.registration.register({...request,name:'Another'},'192.0.2.1'),e=>e.status===409);
 await assert.rejects(service.registration.register(body('Taken','independent'),'192.0.2.1'),e=>e.status===409);
 assert.equal((await service.authenticate(first.token)).id,first.user.id);
 const stored=await db.transaction(async tx=>[...await tx.scan('users',100),...await tx.scan('tokens',100),...await tx.scan('registration-requests',100),...await tx.feed('@tm-replication-v1','0',100)],{readOnly:true});assert.ok(!JSON.stringify(stored).includes(first.token));
 await db.transaction(async tx=>{const user=await tx.get('users',first.user.id);await tx.put('users',user.id,{...user,tokenHash:createHash('sha256').update('new credential').digest('hex')});});
 await assert.rejects(service.registration.register(request,'192.0.2.1'),e=>e.status===409);await assert.rejects(service.authenticate(first.token),e=>e.status===401);
});
test('registration throttles new accounts and a known replay does not spend the limit',async()=>{
 const db=memoryStore(),service=createService(db),requests=[];
 for(let i=0;i<5;i++){const r=body();requests.push(r);await service.registration.register(r,'192.0.2.2');}
 assert.equal((await service.registration.register(requests[0],'192.0.2.2')).replayed,true);
 await assert.rejects(service.registration.register(body(),'192.0.2.2'),e=>e.status===429);
 assert.equal((await db.transaction(tx=>tx.scan('users',100),{readOnly:true})).length,5);
});
test('empty-name registration replay keeps its initially generated profile',async()=>{
 const service=createService(memoryStore()),request=body('');const first=await service.registration.register(request,'192.0.2.3');const replay=await service.registration.register(request,'192.0.2.3');assert.deepEqual(replay.user,first.user);assert.equal(replay.token,first.token);
});
