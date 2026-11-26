import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const dir=new URL('../.secrets/yandex-cloud/',import.meta.url);
const deployment=JSON.parse(await readFile(new URL('deployment.json',dir),'utf8'));
const [a,b]=JSON.parse(await readFile(new URL('test-users.json',dir),'utf8'));
const bases={vps:'https://ch-1.api.tm.ya-erm.ru',cloud:deployment.gatewayUrl};
const checkpoint=()=>JSON.parse(execFileSync('python3',['-c',"import sqlite3,json; c=sqlite3.connect('file:data/messenger.db?mode=ro',uri=True); print(c.execute('SELECT body FROM ReplicationState WHERE key=?',('peer:yandex-1',)).fetchone()[0]); c.close()"],{encoding:'utf8'}));
async function call(channel,path,user,body){const r=await fetch(bases[channel]+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+user.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});const data=await r.json();if(![200,201,202,404].includes(r.status))throw Error('Synthetic bus probe HTTP '+r.status);return {status:r.status,...data.data};}
const created=[],delays={};
try{
 for(const source of ['cloud','vps']){
  const target=source==='vps'?'cloud':'vps',before=checkpoint();assert.ok(before.nextPoll>Date.now()+120000,'Need a healthy idle bus before measuring');
  const id=randomUUID(),at=new Date().toISOString(),operation={protocolVersion:1,operationId:randomUUID(),actorId:a.id,deviceId:randomUUID(),occurredAt:at,type:'message.create',message:{id,fromUserId:a.id,toUserId:b.id,kind:'text',text:'Direct bus proof '+source,sentAt:at}};
  const start=Date.now();await call(source,'/api/mutations',a,operation);created.push({source,operation});
  let arrived=false;while(Date.now()-start<30000){const value=await call(target,'/api/messages/'+id,b);if(value.message?.text===operation.message.text){arrived=true;break;}await new Promise(r=>setTimeout(r,500));}
  assert.ok(arrived,'Bus delivery timed out');delays[source+'To'+target+'Ms']=Date.now()-start;
  assert.equal(checkpoint().lastSuccess,before.lastSuccess,'Message must arrive without an HTTP exchange');
 }
 const proof={realQueueBothDirections:true,payloadDeliveredWithoutHttpCatchup:true,...delays,completedAt:new Date().toISOString()};await writeFile(new URL('bus-replication-proof.json',dir),JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}finally{for(const {source,operation} of created)try{await call(source,'/api/mutations',a,{protocolVersion:1,operationId:randomUUID(),actorId:a.id,deviceId:operation.deviceId,occurredAt:new Date().toISOString(),type:'message.delete',deletion:{messageId:operation.message.id,scope:'everyone'}});}catch{}}
