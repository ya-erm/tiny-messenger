import {GET as adminGet} from "../src/app/api/admin/[action]/route";
import {POST as yandexPost} from "../src/app/api/auth/yandex/[action]/route";
import {makeYandexFlow,exchangeYandexCode,sha256url} from "../src/lib/yandex/protocol";
import {POST as localTelemetry} from "../src/app/api/client/telemetry/route";
import {POST as rotateLocal} from "../src/app/api/me/token/route";
import {authenticateToken} from "../src/lib/auth";
import assert from 'node:assert/strict';import{randomUUID,randomBytes}from'node:crypto';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';
import{prisma,read,write}from'../src/lib/db';import{synchronizeInstallations}from'../src/lib/replication/synchronize';
import{memoryStore}from'../cloud/yandex/tests/memory-store.mjs';import{createService}from'../cloud/yandex/src/service.mjs';import{createHandler}from'../cloud/yandex/src/handler.mjs';import{createReplication}from'../cloud/yandex/src/replication.mjs';
import{POST as localRegister}from'../src/app/api/auth/register/route';import{PATCH as localProfile}from'../src/app/api/me/route';import{DELETE as localDeleteContact}from'../src/app/api/contacts/[id]/route';
const temporary=await mkdtemp(tmpdir()+'/tm-registration-'),originalFetch=globalThis.fetch;
const yandex={clientId:'test-client',clientSecret:'test-secret',sessionKey:'a'.repeat(64),origins:['https://client.example']};
process.env.YANDEX_OAUTH_CLIENT_ID=yandex.clientId;process.env.YANDEX_OAUTH_CLIENT_SECRET=yandex.clientSecret;process.env.TM_WEB_SESSION_SECRET=yandex.sessionKey;process.env.TM_AUTH_ALLOWED_ORIGINS=yandex.origins.join(',');
const db=memoryStore(),cloud=createService(db,'yandex-1',{yandex}),secret='x'.repeat(64),config={TM_INSTALLATION_ID:'yandex-1',TM_REPLICATION_PEER:'vps-1',TM_REPLICATION_SECRET:secret};cloud.exchange=createReplication(db,cloud,config);const handler=createHandler(async()=>cloud,config);
const registration=(name:string,nickname:string)=>({name,nickname,clientRequestId:randomUUID(),registrationToken:'msg_'+randomBytes(12).toString('base64url')});
async function local(method:any,body:any,token='',id?:string,verb='POST',expected=200){const response=await method(new Request('https://local.example/api/test',{method:verb,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}),{params:Promise.resolve({id})});const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value.error));return value.data;}
async function remote(path:string,body:any,token='',verb='POST',expected=200){const response=await handler({httpMethod:verb,path,headers:{...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),requestContext:{identity:{sourceIp:'198.51.100.'+(++ip)}}});const value=JSON.parse(response.body);assert.equal(response.statusCode,expected,JSON.stringify(value.error));return value.data;}
let ip=0;
async function drain(){for(let i=0;i<50;i++){await write(async tx=>{const key='peer:yandex-1',r=await tx.replicationState.findUnique({where:{key}});if(r){const state=JSON.parse(r.body);state.nextPoll=0;state.retryAt=0;await tx.replicationState.update({where:{key},data:{body:JSON.stringify(state)}});}});const r=await synchronizeInstallations()as any;assert.equal(r.error,undefined,JSON.stringify(r));if(!r.sent&&!r.sentRows&&!r.received&&!r.directoryItems)return;}throw Error('Sync did not converge');}
try{
 process.env.TM_INSTALLATION_ID='vps-1';process.env.TM_REPLICATION_CONFIG=temporary+'/config.json';await writeFile(process.env.TM_REPLICATION_CONFIG,JSON.stringify({url:'https://cloud.example/exchange',secret,installationId:'vps-1',peerId:'yandex-1',bootstrapFile:temporary+'/bootstrap.json'}));await writeFile(temporary+'/bootstrap.json',JSON.stringify({formatVersion:1,createdAt:new Date().toISOString(),messages:[],operations:[],deletions:[]}));
 globalThis.fetch=(async(url,init)=>{assert.equal(String(url),'https://cloud.example/exchange');const response=await handler({httpMethod:'POST',path:'/api/internal/replication/exchange',headers:init?.headers,body:init?.body});return new Response(response.body,{status:response.statusCode});})as typeof fetch;
 const home=await local(localRegister,registration('Home','home'),'',undefined,'POST',201);await drain();
 const a=registration('Cloud account','cloud_account'),created=await remote('/api/auth/register',a,'','POST',201);assert.equal(created.user.id,a.clientRequestId);assert.equal(created.token,a.registrationToken);
 assert.equal((await remote('/api/auth/register',a)).replayed,true);await remote('/api/auth/register',{...a,name:'Collision'},'','POST',409);await remote('/api/auth/register',registration('Duplicate','cloud_account'),'','POST',409);
 assert.equal((await remote('/api/auth/session',{token:created.token})).user.id,created.user.id);
 await remote('/api/contacts',{identifier:'@home'},created.token,'POST',201);
 await drain();assert.equal((await read(d=>d.user.findUniqueOrThrow({where:{id:created.user.id}}))).tokenHash,(await cloud.authenticate(created.token)).tokenHash);assert.equal(await read(d=>d.contact.count({where:{ownerId:created.user.id,userId:home.user.id}})),1);
 await remote('/api/messages',{toUserId:home.user.id,text:'New user independently online',clientRequestId:randomUUID()},created.token,'POST',201);await drain();assert.equal(await read(d=>d.message.count({where:{fromUserId:created.user.id,toUserId:home.user.id}})),1);
 await remote('/api/contacts/'+home.user.id,{},created.token,'DELETE');await drain();assert.equal(await read(d=>d.contact.count({where:{ownerId:created.user.id,userId:home.user.id}})),0);
 // Both isolated servers acknowledge the same nickname. Earlier server time wins.
 const early=await remote('/api/auth/register',registration('Earlier cloud','contested'),'','POST',201);
 await new Promise(r=>setTimeout(r,5));const late=await local(localRegister,registration('Later VPS','contested'),'',undefined,'POST',201);await drain();
 assert.equal((await read(d=>d.user.findUniqueOrThrow({where:{id:early.user.id}}))).nickname,'contested');assert.equal((await read(d=>d.user.findUniqueOrThrow({where:{id:late.user.id}}))).nickname,null);assert.equal((await cloud.authenticate(late.token)).nickname,undefined);
 const renamedEarly=await remote('/api/auth/register',registration('Early rename','rename_conflict'),'','POST',201);
 await new Promise(r=>setTimeout(r,5));await local(localProfile,{name:'Home',nickname:'rename_conflict'},home.token,undefined,'PATCH');await drain();
 assert.equal((await read(d=>d.user.findUniqueOrThrow({where:{id:renamedEarly.user.id}}))).nickname,'rename_conflict');
 assert.equal((await read(d=>d.user.findUniqueOrThrow({where:{id:home.user.id}}))).nickname,null,'Claim time, not the old account creation time, decides a renamed nickname');
 // A replay must not restore a token rotated on the VPS.
 const current=await read(d=>d.user.findUniqueOrThrow({where:{id:created.user.id}}));await write(tx=>tx.user.update({where:{id:current.id},data:{tokenHash:'a'.repeat(64),updatedAt:new Date().toISOString()}}));
 const events=await db.transaction(tx=>tx.feed('@tm-replication-v1','0',1000),{readOnly:true});const first=events.find(e=>e.type==='user'&&e.user.id===created.user.id);
 const{importNewPeerUser}=await import('../src/lib/replication/users');await write(tx=>importNewPeerUser(tx,first.user));assert.equal((await read(d=>d.user.findUniqueOrThrow({where:{id:current.id}}))).tokenHash,'a'.repeat(64));
 await local(localRegister,a,'',undefined,'POST',409);await drain();await remote('/api/auth/register',a,'','POST',409);
 const stable=registration('Stable VPS','stable_vps');const firstLocal=await local(localRegister,stable,'',undefined,'POST',201);assert.equal((await local(localRegister,stable)).token,firstLocal.token);

 // Profile edits and rotations must remain usable during a partition.
 await drain();
 const change=()=>({operationId:randomUUID(),replacementToken:'msg_'+randomBytes(12).toString('base64url')});
 const cloudChange=change();await remote('/api/me/token',cloudChange,firstLocal.token);
 assert.equal((await authenticateToken(firstLocal.token)).id,firstLocal.user.id,'The disconnected VPS still accepts the previous credential');
 await local(localProfile,{name:'Offline VPS edit',nickname:'stable_vps'},firstLocal.token,undefined,'PATCH');
 await drain();assert.equal((await authenticateToken(cloudChange.replacementToken)).name,'Offline VPS edit');assert.equal((await cloud.authenticate(cloudChange.replacementToken)).name,'Offline VPS edit');
 await assert.rejects(authenticateToken(firstLocal.token));await assert.rejects(cloud.authenticate(firstLocal.token));
 assert.equal((await remote('/api/me/token',cloudChange,firstLocal.token)).token,cloudChange.replacementToken,'Retry after a lost cloud response');
 const rootChange=change();await local(rotateLocal,rootChange,cloudChange.replacementToken);assert.equal((await local(rotateLocal,rootChange,cloudChange.replacementToken)).token,rootChange.replacementToken,'Retry after a lost VPS response');
 await drain();assert.equal((await cloud.authenticate(rootChange.replacementToken)).id,firstLocal.user.id);
 await remote('/api/me',{name:'Offline cloud edit',nickname:'stable_vps'},rootChange.replacementToken,'PATCH');await drain();assert.equal((await authenticateToken(rootChange.replacementToken)).name,'Offline cloud edit');
 const left=change(),right=change();await local(rotateLocal,left,rootChange.replacementToken);await remote('/api/me/token',right,rootChange.replacementToken);
 await drain();const finalLocal=await read(d=>d.user.findUniqueOrThrow({where:{id:firstLocal.user.id}}));let winning:string|undefined;for(const candidate of [left.replacementToken,right.replacementToken]){try{await authenticateToken(candidate);winning=candidate;}catch{}}
 assert.ok(winning);assert.equal((await cloud.authenticate(winning)).tokenHash,finalLocal.tokenHash);await assert.rejects(cloud.authenticate(rootChange.replacementToken));
 const shared={...change(),changedAt:new Date(Date.now()+1).toISOString()};await local(rotateLocal,shared,winning!);await remote('/api/me/token',shared,winning!);await drain();assert.equal((await cloud.authenticate(shared.replacementToken)).id,firstLocal.user.id);assert.equal((await authenticateToken(shared.replacementToken)).id,firstLocal.user.id);


 const device=randomUUID(),observation={id:randomUUID(),deviceId:device,sessionId:randomUUID(),sequence:1,at:new Date().toISOString(),mode:'auto',channel:'yandex-1',reason:'startup',latencyMs:37,browser:'Test',platform:'Test',pwa:true,appVersion:'test',origin:'https://client.example'};
 await remote('/api/client/telemetry',observation,shared.replacementToken);await drain();const telemetryKey='device-telemetry:'+firstLocal.user.id+':'+device;const localDevice=await read(d=>d.replicationState.findUniqueOrThrow({where:{key:telemetryKey}}));assert.equal(JSON.parse(localDevice.body).current.channel,'yandex-1');
 await local(localTelemetry,{...observation,id:randomUUID(),sequence:2,channel:'vps-direct',reason:'manual'},shared.replacementToken);await drain();const remoteDevice=await db.transaction(tx=>tx.get('device-telemetry',firstLocal.user.id+':'+device));assert.equal(remoteDevice.current.channel,'vps-direct');assert.equal(remoteDevice.history.length,2);
 // Provider verification is mocked; SQLite/YDB adapters and HTTP replication remain real.
 const verifier='v'.repeat(64);
 async function yandexProof(mode:'link'|'login',actor?:any,subject='test-provider-subject'){
  const flow=makeYandexFlow(yandex,{mode,origin:yandex.origins[0],challenge:sha256url(verifier)},actor);
  return {...await exchangeYandexCode(yandex,{state:flow.state,code:'test-code',verifier},(async(url:any)=>Response.json(String(url).includes('/token')?{access_token:'temporary-provider-token'}:{psuid:subject,client_id:yandex.clientId,display_name:'Example'}))as typeof fetch),verifier};
 }
 const rootYandex=(request:Request)=>yandexPost(request,{params:Promise.resolve({action:'finish'})});
 const actor=await authenticateToken(shared.replacementToken),linkProof=await yandexProof('link',actor);
 await local(rootYandex,linkProof,shared.replacementToken);await drain();
 const loginProof=await yandexProof('login');
 const cloudSession=await remote('/api/auth/yandex/finish',loginProof);
 assert.equal((await authenticateToken(cloudSession.token)).id,actor.id);
 assert.equal((await cloud.authenticate(cloudSession.token)).id,actor.id);
 const rootSession=await local(rootYandex,loginProof);
 assert.equal((await cloud.authenticate(rootSession.token)).id,actor.id);
 const rotation={...change(),changedAt:new Date(Date.now()+2).toISOString()};
 await local(rotateLocal,rotation,rootSession.token);await local(rotateLocal,rotation,rootSession.token);await drain();
 await assert.rejects(authenticateToken(rootSession.token));await assert.rejects(cloud.authenticate(rootSession.token));
 const afterRotation=await remote('/api/auth/yandex/finish',loginProof);assert.equal((await authenticateToken(afterRotation.token)).id,actor.id);
 const cloudActor=await cloud.authenticate(early.token),cloudLink=await yandexProof('link',cloudActor,'second-provider-subject');
 await remote('/api/auth/yandex/finish',cloudLink,early.token);await drain();
 const secondLogin=await local(rootYandex,await yandexProof('login',undefined,'second-provider-subject'));
 assert.equal((await cloud.authenticate(secondLogin.token)).id,early.user.id);
 process.env.TM_ADMIN_USER_IDS=actor.id;(config as any).TM_ADMIN_USER_IDS=actor.id;
 const adminRoot=(request:Request)=>adminGet(request,{params:Promise.resolve({action:'users'})});
 const adminAccounts=await local(adminRoot,undefined,afterRotation.token,undefined,'GET');
 assert.ok(adminAccounts.users.some((user:any)=>user.id===actor.id));assert.ok(!JSON.stringify(adminAccounts).includes('tokenHash'));
 const cloudAccounts=await remote('/api/admin/users',undefined,afterRotation.token,'GET');assert.equal(cloudAccounts.users.length,adminAccounts.users.length);
 const metrics=(users:any[])=>users.map(user=>({id:user.id,counters:user.counters,daily:user.daily})).sort((a,b)=>a.id.localeCompare(b.id));assert.deepEqual(metrics(cloudAccounts.users),metrics(adminAccounts.users),'Admin counters and daily history converge across adapters');
 await local(adminRoot,undefined,home.token,undefined,'GET',403);await remote('/api/admin/users',undefined,home.token,'GET',403);
 const adminRange={timeZone:'Europe/Moscow',from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+60000).toISOString()},timelineQuery=new URLSearchParams({...adminRange,users:actor.id});
 const rootTimeline=await adminGet(new Request('https://local.example/api/admin/timeline?'+timelineQuery,{headers:{Authorization:'Bearer '+afterRotation.token}}),{params:Promise.resolve({action:'timeline'})});assert.equal(rootTimeline.status,200);const rootTimelineData=(await rootTimeline.json()).data;
 const cloudTimeline=await remote('/api/admin/timeline?'+timelineQuery,undefined,afterRotation.token,'GET');assert.deepEqual(rootTimelineData.users,cloudTimeline.users);assert.ok(rootTimelineData.users[0].devices.length>0);
 await remote('/api/admin/timeline?'+timelineQuery,undefined,home.token,'GET',403);
 const deniedTimeline=await adminGet(new Request('https://local.example/api/admin/timeline?'+timelineQuery,{headers:{Authorization:'Bearer '+home.token}}),{params:Promise.resolve({action:'timeline'})});assert.equal(deniedTimeline.status,403);
 const userQuery=new URLSearchParams(adminRange),zoneRoot=await adminGet(new Request('https://local.example/api/admin/users?'+userQuery,{headers:{Authorization:'Bearer '+afterRotation.token}}),{params:Promise.resolve({action:'users'})});assert.equal(zoneRoot.status,200);const zoneData=(await zoneRoot.json()).data,zoneCloud=await remote('/api/admin/users?'+userQuery,undefined,afterRotation.token,'GET');assert.equal(zoneData.timeZone,'Europe/Moscow');assert.deepEqual(metrics(zoneData.users),metrics(zoneCloud.users));
 await remote('/api/admin/users?timeZone=invalid',undefined,afterRotation.token,'GET',422);
 console.log(JSON.stringify({timezoneRangeParity:true,timelineParity:true,timelineOwnerOnly:true}));
 console.log(JSON.stringify({adminExplicitAllowlist:true,adminNativeAndYandexSessions:true,noCredentialsInAdmin:true}));
 console.log(JSON.stringify({yandexBindingBidirectional:true,portableSessions:true,sessionRevocationReplicated:true}));
 console.log(JSON.stringify({deviceTelemetryReplicated:true,independentTokenRotation:true,independentProfileEdits:true,lostResponseRetry:true,concurrentRotationsConverge:true,cloudRegistrationWithoutVps:true,stableTokenAndRetry:true,nicknameUniqueness:true,usersAndCredentialsReplicated:true,cloudContactsBidirectional:true,newUserCanMessage:true,isolatedNicknameConflictResolved:true,replayDoesNotRestoreRevokedToken:true}));
}finally{globalThis.fetch=originalFetch;await prisma.$disconnect();await rm(temporary,{recursive:true,force:true});}
