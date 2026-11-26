import test from 'node:test';
import assert from 'node:assert/strict';
import {publishToTarget} from './delivery.mjs';
import {busHealth,busProbeInterval,isBusHealthy,makeBusFrame} from './format.mjs';
const target={installationId:'cloud',address:'https://broker.example/inbox',direct:{url:'https://api.example/events',secret:'x'.repeat(64)}};
const frames=[makeBusFrame('vps','cloud','events','packet-1',{events:[{type:'mutation',operation:{operationId:'stable-id'}}]})];
test('direct delivery carries the existing envelope and acknowledges durable processing',async()=>{
 let requests=0;
 const result=await publishToTarget({publish:async()=>{throw Error('Broker should not be used');}},target,frames,async(url,init)=>{
  requests++;assert.equal(String(url),target.direct.url);assert.equal(init.headers['x-tm-replication-key'],target.direct.secret);assert.deepEqual(JSON.parse(init.body),frames[0]);
  return Response.json({ok:true,data:{processed:1}});
 });assert.equal(result.route,'direct');assert.equal(requests,1);
});
test('lost direct response replays every original frame through the broker',async()=>{
 const batch=[...frames,{...frames[0],id:'packet-2'}];let calls=0,published;
 const result=await publishToTarget({publish:async(address,value)=>{assert.equal(address,target.address);published=value;}},target,batch,async()=>{
  if(++calls===1)return Response.json({ok:true,data:{processed:1}});throw Error('Lost acknowledgement after commit');
 });assert.equal(result.route,'broker');assert.deepEqual(published,batch);
});
test('invalid acknowledgements and HTTP errors fall back; failure of both paths remains retryable',async()=>{
 for(const response of [Response.json({ok:true,data:{processed:0}}),new Response('unavailable',{status:503}),new Response('<html/>')]){
  let used=false;await publishToTarget({publish:async()=>{used=true;}},target,frames,async()=>response);assert.equal(used,true);
 }
 await assert.rejects(publishToTarget({publish:async()=>{throw Error('Queue unavailable');}},target,frames,async()=>{throw Error('HTTP unavailable');}),/Queue unavailable/);
});
test('broker-only targets retain their provider and credentials never travel over plaintext HTTP',async()=>{
 let published=false;await publishToTarget({publish:async()=>{published=true;}},{...target,direct:undefined},frames);assert.equal(published,true);
 await assert.rejects(publishToTarget({publish:async()=>{}},{...target,direct:{...target.direct,url:'http://api.example/events'}},frames,async()=>{throw Error('Must not send');}),/Invalid direct/);
});
test('idle probes are rare without making the HTTP fallback poll every minute',()=>{
 const h=busHealth(),now=10_000_000;
 Object.assign(h,{listenerAt:now,confirmedAt:now-600_000,failedAt:0,receivedAt:0,activityAt:0,probeAt:now-600_000});
 assert.equal(busProbeInterval(now),1800_000);assert.equal(isBusHealthy(now),true);
 h.activityAt=now;assert.equal(busProbeInterval(now),60_000);assert.equal(isBusHealthy(now),false);
 h.confirmedAt=now;assert.equal(isBusHealthy(now),true);h.failedAt=now+1;assert.equal(isBusHealthy(now+2),false);
 h.activityAt=0;assert.equal(busProbeInterval(now+2),60_000,"Known failures retain quick recovery even after local activity stops");
 h.failedAt=0;h.confirmedAt=now;h.probeAt=now+1;assert.equal(busProbeInterval(now+2),60_000,"Unacknowledged probes keep recovery active");
 Object.assign(h,{listenerAt:0,confirmedAt:0,failedAt:0,receivedAt:0,activityAt:0,probeAt:0});
});
