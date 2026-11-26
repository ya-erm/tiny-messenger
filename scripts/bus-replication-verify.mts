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
const queues=new Map([[config.bus.inbox,[]],[config.bus.targets[0].address,[]]]);let exchanges=0,lose=false;
function creation(text:string){const at=new Date().toISOString();return{protocolVersion:1 as const,operationId:randomUUID(),actorId:users[0].id,deviceId:randomUUID(),occurredAt:at,type:"message.create" as const,message:{id:randomUUID(),fromUserId:users[0].id,toUserId:users[1].id,kind:"text" as const,text,sentAt:at}};}
async function deliverCloud(){const q=queues.get(config.bus.targets[0].address)!;while(q.length)await consumeCloudFrames(cloud,[q.shift()],env);}
async function deliverVps(){const q=queues.get(config.bus.inbox)!;while(q.length)await receiveBusFrame(q.shift());}
try{
 process.env.TM_INSTALLATION_ID="vps-1";process.env.TM_REPLICATION_CONFIG=temporary+"/config.json";
 await writeFile(temporary+"/config.json",JSON.stringify(config));await writeFile(config.bootstrapFile,JSON.stringify({formatVersion:1,createdAt:now,messages:[],operations:[],deletions:[]}));
 await write(async tx=>{for(const user of users)await tx.user.create({data:user});});
 globalThis.fetch=(async(url,init)=>{
  if(String(url)==="https://cloud.example/exchange"){exchanges++;return new Response(JSON.stringify({ok:true,data:await cloud.exchange(JSON.parse(String(init?.body)))}));}
  const p=new URLSearchParams(String(init?.body));assert.equal(p.get("Action"),"SendMessageBatch");
  for(const [key,value]of p)if(key.endsWith(".MessageBody"))queues.get(p.get("QueueUrl")!)!.push(JSON.parse(value) as never);
  if(lose){lose=false;throw Error("Lost publish response");}
  return new Response("<Response/>");
 })as typeof fetch;
 for(let i=0;i<10;i++){await write(async tx=>{const key="peer:yandex-1",record=await tx.replicationState.findUnique({where:{key}});if(record){const state=JSON.parse(record.body);state.nextPoll=0;await tx.replicationState.update({where:{key},data:{body:JSON.stringify(state)}});}});const r=await synchronizeInstallations()as any;assert.equal(r.error,undefined);if(!r.directoryItems&&!r.sent&&!r.sentRows&&!r.received)break;}
 await publishLocalBus();
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
 console.log(JSON.stringify({directDataBothDirections:true,richEntitiesOverBus:true,noHttpPullForDelivery:true,noEcho:true,roundTripHealth:true,rareCatchupWhenHealthy:true,fallbackOnBusFailure:true,lostPublishResponseDeduplicated:true}));
}finally{globalThis.fetch=originalFetch;Object.assign(busHealth(),{listenerAt:0,confirmedAt:0,failedAt:0});await prisma.$disconnect();await rm(temporary,{recursive:true,force:true});}
