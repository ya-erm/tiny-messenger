import {applyExternalLink} from "../src/lib/replication/external-protocol";
import {appendReplication} from "../cloud/yandex/src/replication.mjs";
import {storeObservation,queueObservation} from "../src/lib/replication/telemetry-protocol";
import {identityStore} from "../src/lib/replication/identity";
import {recordIdentity} from "../src/lib/replication/identity";
import assert from "node:assert/strict";
import {randomUUID,createHash}from"node:crypto";
import{readFile,writeFile,mkdtemp,rm}from"node:fs/promises";
import{tmpdir}from"node:os";
import{prisma,read,write}from"../src/lib/db";
import{acceptMutation}from"../src/lib/mutations/accept";
import{synchronizeInstallations}from"../src/lib/replication/synchronize";
import{publishLocalBus,receiveBusFrame}from"../src/lib/replication/bus";
import{busHealth,makeBusFrame}from"./replication-bus/format.mjs";
import{memoryStore}from"../cloud/yandex/tests/memory-store.mjs";
import{createService}from"../cloud/yandex/src/service.mjs";
import{createReplication}from"../cloud/yandex/src/replication.mjs";
import{flushCloudBus,consumeCloudFrames}from"../cloud/yandex/src/bus.mjs";
const temporary=await mkdtemp(tmpdir()+"/tm-bus-");const originalFetch=globalThis.fetch;
const now=new Date().toISOString();const users=[0,1].map(i=>({id:randomUUID(),name:"Bus user "+i,tokenHash:createHash("sha256").update(randomUUID()).digest("hex"),createdAt:now,updatedAt:now}));
const database=memoryStore(),cloud=createService(database,"yandex-1");cloud.exchange=createReplication(database,cloud,{TM_REPLICATION_PEER:"vps-1"});
const credentials={accessKeyId:"TEST",secretAccessKey:"SECRET"};
const config={url:"https://cloud.example/exchange",secret:"x".repeat(64),installationId:"vps-1",peerId:"yandex-1",bootstrapFile:temporary+"/bootstrap.json",bus:{enabled:true,provider:"ymq",credentials,inbox:"https://queue.example/vps",targets:[{installationId:"yandex-1",address:"https://queue.example/cloud"}]}};
const env={TM_BUS_CONFIG:JSON.stringify({enabled:true,provider:"ymq",credentials,bootstrapCursor:"0",targets:[{installationId:"vps-1",address:config.bus.inbox}]})};
let directCalls=0,directUnavailable=false;
const queues=new Map([[config.bus.inbox,[]],[config.bus.targets[0].address,[]]]);let exchanges=0,lose=false;
function creation(text:string){const at=new Date().toISOString();return{protocolVersion:1 as const,operationId:randomUUID(),actorId:users[0].id,deviceId:randomUUID(),occurredAt:at,type:"message.create" as const,message:{id:randomUUID(),fromUserId:users[0].id,toUserId:users[1].id,kind:"text" as const,text,sentAt:at}};}
async function deliverCloud(){const q=queues.get(config.bus.targets[0].address)!;while(q.length)await consumeCloudFrames(cloud,[q.shift()],env);}
async function deliverVps(){const q=queues.get(config.bus.inbox)!;while(q.length)await receiveBusFrame(q.shift());}
try{
 process.env.TM_INSTALLATION_ID="vps-1";process.env.TM_REPLICATION_CONFIG=temporary+"/config.json";
 await writeFile(temporary+"/config.json",JSON.stringify(config));await writeFile(config.bootstrapFile,JSON.stringify({formatVersion:1,createdAt:now,messages:[],operations:[],deletions:[]}));
 await write(async tx=>{for(const user of users)await tx.user.create({data:user});});
 globalThis.fetch=(async(url,init)=>{
  if(String(url)==="https://cloud.example/events"){
    directCalls++;
    if(directUnavailable)throw Error("Direct endpoint unavailable");
    assert.equal(new Headers(init?.headers).get("x-tm-replication-key"),config.secret);
    const value=await consumeCloudFrames(cloud,[JSON.parse(String(init?.body))],env);
    return new Response(JSON.stringify({ok:true,data:value}));
  }
  if(String(url)==="https://cloud.example/exchange"){exchanges++;return new Response(JSON.stringify({ok:true,data:await cloud.exchange(JSON.parse(String(init?.body)))}));}
  const p=new URLSearchParams(String(init?.body));assert.equal(p.get("Action"),"SendMessageBatch");
  for(const [key,value]of p)if(key.endsWith(".MessageBody"))queues.get(p.get("QueueUrl")!)!.push(JSON.parse(value) as never);
  if(lose){lose=false;throw Error("Lost publish response");}
  return new Response("<Response/>");
 })as typeof fetch;
 for(let i=0;i<10;i++){await write(async tx=>{const key="peer:yandex-1",record=await tx.replicationState.findUnique({where:{key}});if(record){const state=JSON.parse(record.body);state.nextPoll=0;await tx.replicationState.update({where:{key},data:{body:JSON.stringify(state)}});}});const r=await synchronizeInstallations()as any;assert.equal(r.error,undefined);if(!r.directoryItems&&!r.sent&&!r.sentRows&&!r.received)break;}
 await publishLocalBus();
 const credentialChange={kind:"token",previousTokenHash:users[0].tokenHash,tokenHash:createHash("sha256").update("bus token change").digest("hex")};
 await write(tx=>recordIdentity(tx,users[0].id,credentialChange));await publishLocalBus();await deliverCloud();assert.equal((await database.transaction(tx=>tx.get("users",users[0].id))).tokenHash,credentialChange.tokenHash);
 const beforeIdentity=await read(db=>db.user.findUniqueOrThrow({where:{id:users[1].id}}));await cloud.identity.profile(beforeIdentity,{name:"Cloud bus profile"});await flushCloudBus(cloud,env);await deliverVps();assert.equal((await read(db=>db.user.findUniqueOrThrow({where:{id:users[1].id}}))).name,"Cloud bus profile");

 const observation={id:randomUUID(),userId:users[0].id,deviceId:randomUUID(),sessionId:randomUUID(),sequence:1,at:new Date().toISOString(),mode:'auto',channel:'vps-direct',reason:'latency',latencyMs:12,browser:'Test',platform:'Test',pwa:true,appVersion:'test',origin:'https://client.example',receivedAt:new Date().toISOString(),installationId:'vps-1'};
 await write(async tx=>{const store=identityStore(tx);await storeObservation(store,observation);await queueObservation(store,observation);});await publishLocalBus();await deliverCloud();assert.equal((await database.transaction(tx=>tx.get('device-telemetry',users[0].id+':'+observation.deviceId))).current.channel,'vps-direct');
 await cloud.telemetry(users[0],{...observation,id:randomUUID(),sequence:2,channel:'yandex-1'});await flushCloudBus(cloud,env);await deliverVps();assert.equal(JSON.parse((await read(db=>db.replicationState.findUniqueOrThrow({where:{key:'device-telemetry:'+users[0].id+':'+observation.deviceId}}))).body).current.channel,'yandex-1');
 const external={version:1 as const,id:randomUUID(),userId:users[0].id,provider:'yandex' as const,subjectHash:'a'.repeat(64),at:new Date().toISOString(),deleted:false,label:'Test binding'};
 await write(async tx=>{const store=identityStore(tx);await applyExternalLink(store,external);await store.put('external-pending',external.id,external);});
 await publishLocalBus();await deliverCloud();assert.equal((await database.transaction(tx=>tx.get('external-users',users[0].id))).id,external.id);
 const cloudExternal={...external,id:randomUUID(),userId:users[1].id,subjectHash:'b'.repeat(64)};
 await database.transaction(async tx=>{await applyExternalLink(tx,cloudExternal);await appendReplication(tx,'external:'+cloudExternal.id,{type:'external',operation:cloudExternal});});
 await flushCloudBus(cloud,env);await deliverVps();assert.equal(JSON.parse((await read(db=>db.replicationState.findUniqueOrThrow({where:{key:'external-users:'+users[1].id}}))).body).id,cloudExternal.id);
 await synchronizeInstallations();
 const baseline=exchanges;
 const outgoing=creation("Actual event body VPS → cloud");await write(tx=>acceptMutation(tx,outgoing,users[0]));await publishLocalBus();
 assert.equal(queues.get(config.bus.targets[0].address)![0].events[0].operation.message.text,outgoing.message.text);
 await deliverCloud();assert.equal((await cloud.message(users[1],outgoing.message.id)).text,outgoing.message.text);
 const incoming=creation("Actual event body cloud → VPS");await cloud.mutate(users[0],incoming);await flushCloudBus(cloud,env);await deliverVps();
 assert.equal((await read(db=>db.message.findUniqueOrThrow({where:{id:incoming.message.id}}))).text,incoming.message.text);
 assert.equal((await read(db=>db.mutationOperation.findUniqueOrThrow({where:{operationId:incoming.operationId}}))).originId,"yandex-1");
 await publishLocalBus();assert.equal(queues.get(config.bus.targets[0].address)!.length,0,"Imported operation must not echo");
 const group=await cloud.rows.modifyGroup(users[0],randomUUID(),{name:"Bus group",memberIds:[users[1].id]},"create");await flushCloudBus(cloud,env);await deliverVps();
 assert.equal(await read(db=>db.groupMember.count({where:{groupId:group.group.id}})),2);
 assert.equal(exchanges,baseline,"Data delivery must not use HTTP catch-up");
 // A round trip, not a socket alone, permits rare full reconciliation.
 busHealth().listenerAt=Date.now();await consumeCloudFrames(cloud,[makeBusFrame("vps-1","yandex-1","ping","probe")],env);await deliverVps();
 assert.ok(busHealth().confirmedAt>0);
 await write(async tx=>{const key="peer:yandex-1",record=await tx.replicationState.findUniqueOrThrow({where:{key}});const state=JSON.parse(record.body);state.nextPoll=Date.now()+1800000;await tx.replicationState.update({where:{key},data:{body:JSON.stringify(state)}});});
 await synchronizeInstallations();assert.equal(exchanges,baseline,"Healthy bus skips the old short-poll deadline");
 busHealth().failedAt=Date.now()+1;await synchronizeInstallations();assert.ok(exchanges>baseline,"Failed bus triggers catch-up without waiting thirty minutes");
 const repeated=creation("Lost acknowledgement");await write(tx=>acceptMutation(tx,repeated,users[0]));lose=true;const failure=await publishLocalBus()as any;assert.equal(failure.error,"publish_failed");
 await write(async tx=>{const row=await tx.replicationState.findUniqueOrThrow({where:{key:"bus:outgoing"}});const state=JSON.parse(row.body);state.retryAt=0;await tx.replicationState.update({where:{key:row.key},data:{body:JSON.stringify(state)}});});
 await publishLocalBus();await deliverCloud();assert.equal((await cloud.snapshot(users[1])).messages.filter(m=>m.id===repeated.message.id).length,1);
 const directTarget=config.bus.targets[0] as any;
 directTarget.direct={url:"https://cloud.example/events",secret:config.secret};await writeFile(temporary+"/config.json",JSON.stringify(config));
 const direct=creation("Direct HTTP event delivery");await write(tx=>acceptMutation(tx,direct,users[0]));
 const directBefore=directCalls;await publishLocalBus();assert.ok(directCalls>directBefore);
 assert.equal(queues.get(directTarget.address)!.length,0,"Normal outgoing delivery must not publish to the cloud queue");
 assert.equal((await cloud.message(users[1],direct.message.id)).text,direct.message.text);
 directUnavailable=true;
 const fallback=creation("HTTP outage with queue reserve");await write(tx=>acceptMutation(tx,fallback,users[0]));await publishLocalBus();
 assert.ok(queues.get(directTarget.address)!.length>0);await deliverCloud();
 assert.equal((await cloud.message(users[1],fallback.message.id)).text,fallback.message.text);
 console.log(JSON.stringify({deviceTelemetryOverBus:true,directDataBothDirections:true,richEntitiesOverBus:true,noHttpPullForDelivery:true,noEcho:true,roundTripHealth:true,rareCatchupWhenHealthy:true,fallbackOnBusFailure:true,lostPublishResponseDeduplicated:true,directHttpPreferred:true,queueFallbackOnHttpFailure:true}));
}finally{globalThis.fetch=originalFetch;Object.assign(busHealth(),{listenerAt:0,confirmedAt:0,failedAt:0});await prisma.$disconnect();await rm(temporary,{recursive:true,force:true});}
