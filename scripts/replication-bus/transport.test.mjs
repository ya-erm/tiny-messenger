import test from 'node:test';
import assert from 'node:assert/strict';
import {createYmqTransport} from './ymq.mjs';
import {parseBusFrame,makeBusFrame,isBusHealthy,busHealth} from './format.mjs';
test('format is independent of provider and validates destination, peers and size',()=>{
 const frame=makeBusFrame('vps-1','yandex-1','events','test-1',{events:[{type:'mutation',operation:{operationId:'opaque'}}]});
 assert.equal(parseBusFrame(JSON.stringify(frame),'yandex-1',['vps-1']).events[0].operation.operationId,'opaque');
 assert.throws(()=>parseBusFrame(frame,'other',['vps-1']));assert.throws(()=>parseBusFrame(frame,'yandex-1',[]));
 assert.throws(()=>parseBusFrame({...frame,events:[{type:'sql'}]},'yandex-1',['vps-1']));
 assert.throws(()=>parseBusFrame({...frame,extra:'x'.repeat(250000)},'yandex-1',['vps-1']));
});
test('transport signs requests, decodes deliveries and acknowledges explicitly',async()=>{
 const calls=[];
 const transport=createYmqTransport({credentials:{accessKeyId:'TEST',secretAccessKey:'SECRET'}},async(url,init)=>{
  assert.equal(new URL(url).protocol,'https:');assert.match(init.headers.authorization,/^AWS4-HMAC-SHA256 Credential=TEST\//);
  const p=new URLSearchParams(init.body);calls.push(p.get('Action'));
  if(p.get('Action')==='ReceiveMessage'){
   assert.equal(p.get('WaitTimeSeconds'),'20');
   return new Response('<ReceiveMessageResponse><ReceiveMessageResult><Message><MessageId>m1</MessageId><ReceiptHandle>handle&amp;one</ReceiptHandle><Body>{&quot;value&quot;:1}</Body></Message></ReceiveMessageResult></ReceiveMessageResponse>');
  }
  return new Response('<Response/>');
 });
 const messages=await transport.receive('https://queue.example/inbox');assert.equal(messages[0].body,'{"value":1}');assert.equal(messages[0].handle,'handle&one');
 assert.deepEqual(calls,['ReceiveMessage']);await transport.acknowledge('https://queue.example/inbox',messages);
 await transport.publish('https://queue.example/inbox',[makeBusFrame('vps-1','yandex-1','ping','probe')]);
 assert.deepEqual(calls,['ReceiveMessage','DeleteMessageBatch','SendMessageBatch']);
});
test('partial batch acknowledgement and HTTP errors remain retryable',async()=>{
 const config={credentials:{accessKeyId:'TEST',secretAccessKey:'SECRET'}};
 await assert.rejects(createYmqTransport(config,async()=>new Response('<Response><BatchResultErrorEntry><Code>InternalError</Code></BatchResultErrorEntry></Response>')).publish('https://queue.example', [{}]),/not fully accepted/);
 await assert.rejects(createYmqTransport(config,async()=>new Response('<Error><Code>AccessDenied</Code></Error>',{status:403})).receive('https://queue.example'),/HTTP 403 AccessDenied/);
});
test('connected queue alone is not healthy without a recent round trip',()=>{
 Object.assign(busHealth(),{listenerAt:100000,confirmedAt:0,failedAt:0});assert.equal(isBusHealthy(100001),false);
 busHealth().confirmedAt=100000;assert.equal(isBusHealthy(100001),true);
 busHealth().failedAt=100002;assert.equal(isBusHealthy(100003),false);
});
