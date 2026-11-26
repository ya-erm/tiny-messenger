import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryStore} from './memory-store.mjs';
import {createService} from '../src/service.mjs';
import {flushCloudBus,consumeCloudFrames,consumeQueueEvent} from '../src/bus.mjs';
import {makeBusFrame,parseBusFrame} from '../shared/bus-format.mjs';
const userIds=[randomUUID(),randomUUID()];
async function fixture(){const database=memoryStore();for(const id of userIds)await database.transaction(tx=>tx.put('users',id,{id,name:'Bus test',tokenHash:'x'.repeat(64)}));
 const service=createService(database,'yandex-1');const env={TM_BUS_CONFIG:JSON.stringify({enabled:true,provider:'ymq',credentials:{accessKeyId:'TEST',secretAccessKey:'SECRET'},bootstrapCursor:'0',inboxArn:'private-inbox',targets:[{installationId:'vps-1',address:'https://queue.example/vps'}]})};
 const at=new Date().toISOString();const operation={protocolVersion:1,operationId:randomUUID(),actorId:userIds[0],deviceId:randomUUID(),occurredAt:at,type:'message.create',message:{id:randomUUID(),fromUserId:userIds[0],toUserId:userIds[1],kind:'text',text:'Data over the bus',sentAt:at}};
 return{database,service,env,operation};}
test('publishes actual operations from the durable journal, retries a lost acknowledgement',async()=>{
 const {database,service,env,operation}=await fixture();const originalFetch=globalThis.fetch;const frames=[];let lose=true;
 globalThis.fetch=async(url,init)=>{const p=new URLSearchParams(init.body);for(const [key,value]of p)if(key.endsWith('.MessageBody'))frames.push(JSON.parse(value));if(lose){lose=false;throw Error('lost response');}return new Response('<Response/>');};
 try{await service.mutate({id:userIds[0],name:'Bus test'},operation);await assert.rejects(flushCloudBus(service,env));
 assert.equal(await database.transaction(tx=>tx.get('meta','bus:published')),undefined);
 await flushCloudBus(service,env);assert.equal(frames.length,2);for(const f of frames){const frame=parseBusFrame(f,'vps-1',['yandex-1']);assert.equal(frame.events[0].operation.message.text,'Data over the bus');assert.equal(frame.events[0].operation.operationId,operation.operationId);}
 assert.ok(await database.transaction(tx=>tx.get('meta','bus:published')));
 const before=frames.length;await flushCloudBus(service,env);assert.equal(frames.length,before);
 }finally{globalThis.fetch=originalFetch;}
});
test('consumes data directly with deduplication and no publish echo; ping proves both directions',async()=>{
 const {database,service,env,operation}=await fixture();const originalFetch=globalThis.fetch,frames=[];
 globalThis.fetch=async(url,init)=>{for(const [key,value]of new URLSearchParams(init.body))if(key.endsWith('.MessageBody'))frames.push(JSON.parse(value));return new Response('<Response/>');};
 try{const frame=makeBusFrame('vps-1','yandex-1','events','one',{events:[{type:'mutation',operation}]});await consumeCloudFrames(service,[frame,frame],env);
 assert.equal((await service.message({id:userIds[1]},operation.message.id)).text,operation.message.text);assert.equal((await database.transaction(tx=>tx.scan('operations',100))).length,1);assert.equal(frames.length,0);
 await consumeCloudFrames(service,[makeBusFrame('vps-1','yandex-1','ping','probe')],env);assert.equal(frames[0].kind,'pong');assert.equal(frames[0].id,'probe');
 await assert.rejects(consumeQueueEvent({messages:[{event_metadata:{event_type:'yandex.cloud.events.messagequeue.QueueMessage'},details:{queue_id:'other',message:{body:JSON.stringify(frame)}}}]},service,env),/Unexpected queue source/);
 }finally{globalThis.fetch=originalFetch;}
});
