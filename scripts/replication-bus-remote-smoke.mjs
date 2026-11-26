import {readTestConfiguration,testOrigin} from "../cloud/yandex/tests/config.mjs";
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {publishToTarget} from './replication-bus/delivery.mjs';
import {makeBusFrame} from './replication-bus/format.mjs';
const {directory:dir,deployment,users}=await readTestConfiguration();
const [a,b]=users;
const bases={vps:testOrigin('TM_TEST_PRIMARY_API_ORIGIN'),cloud:testOrigin('TM_CLOUD_TEST_ORIGIN')};
const runtimeFile=process.env.TM_TEST_REPLICATION_CONFIG,databaseFile=process.env.TM_TEST_DATABASE_FILE;
if(!runtimeFile||!databaseFile)throw Error('Set TM_TEST_REPLICATION_CONFIG and TM_TEST_DATABASE_FILE explicitly');
const runtime=JSON.parse(await readFile(runtimeFile,'utf8'));
const checkpoint=()=>JSON.parse(execFileSync('python3',['-c',"import sqlite3,sys; from pathlib import Path; c=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); print(c.execute('SELECT body FROM ReplicationState WHERE key=?',('peer:'+sys.argv[2],)).fetchone()[0]); c.close()",databaseFile,runtime.peerId],{encoding:'utf8'}));
async function call(channel,path,user,body){const r=await fetch(bases[channel]+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+user.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});const data=await r.json();if(![200,201,202,404].includes(r.status))throw Error('Synthetic bus probe HTTP '+r.status);return {status:r.status,...data.data};}
const directTarget=runtime.bus.targets.find(t=>t.installationId===runtime.peerId);
const created=[],delays={};let directVerified=false;
try{
 for(const source of ['cloud','vps']){
  const target=source==='vps'?'cloud':'vps',before=checkpoint();assert.ok(before.nextPoll>Date.now()+120000,'Need a healthy idle bus before measuring');
  const id=randomUUID(),at=new Date().toISOString(),operation={protocolVersion:1,operationId:randomUUID(),actorId:a.id,deviceId:randomUUID(),occurredAt:at,type:'message.create',message:{id,fromUserId:a.id,toUserId:b.id,kind:'text',text:'Direct bus proof '+source,sentAt:at}};
  const start=Date.now();await call(source,'/api/mutations',a,operation);created.push({source,operation});
  let arrived=false;while(Date.now()-start<30000){const value=await call(target,'/api/messages/'+id,b);if(value.message?.text===operation.message.text){arrived=true;break;}await new Promise(r=>setTimeout(r,500));}
  assert.ok(arrived,'Bus delivery timed out');delays[source+'To'+target+'Ms']=Date.now()-start;
  assert.equal(checkpoint().lastSuccess,before.lastSuccess,'Message must arrive without a full HTTP catch-up exchange');
  if(source==='vps'&&directTarget.direct){
   const proof=await publishToTarget({publish:async()=>{throw Error('Direct production probe unexpectedly needed the queue');}},directTarget,[makeBusFrame(runtime.installationId,runtime.peerId,'events',randomUUID(),{events:[{type:'mutation',operation}]})]);
   assert.equal(proof.route,'direct');directVerified=true;
  }
 }
 const proof={realEventDeliveryBothDirections:true,cloudToVpsViaQueue:true,vpsToCloudDirectHttpVerified:directVerified,payloadDeliveredWithoutHttpCatchup:true,...delays,completedAt:new Date().toISOString()};await writeFile(new URL('bus-replication-proof.json',dir),JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}finally{for(const {source,operation} of created)try{await call(source,'/api/mutations',a,{protocolVersion:1,operationId:randomUUID(),actorId:a.id,deviceId:operation.deviceId,occurredAt:new Date().toISOString(),type:'message.delete',deletion:{messageId:operation.message.id,scope:'everyone'}});}catch{}}
