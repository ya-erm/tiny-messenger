import {readTestConfiguration,testOrigin} from "../cloud/yandex/tests/config.mjs";
// Mutates only dedicated synthetic accounts; never call generic API smoke on production.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const {directory:dir,deployment,users}=await readTestConfiguration();
const [a,b]=users;
const bases={vps:testOrigin('TM_TEST_PRIMARY_API_ORIGIN'),cloud:testOrigin('TM_CLOUD_TEST_ORIGIN')};
const groups=[],messages=[],timings=[];let requests=0;
async function call(channel,path,user=a,body,method=body===undefined?'GET':'POST',expected=[200,201]){
 requests++;const response=await fetch(bases[channel]+path,{method,headers:{authorization:'Bearer '+user.token,'content-type':'application/json','x-tm-request-id':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});
 const result=await response.json();
 if(!expected.includes(response.status))throw Error(`${channel} ${method} ${path.split('?')[0]} HTTP ${response.status}: ${result.error?.code||'unknown'}`);
 return {status:response.status,...result.data};
}
async function eventually(channel,path,user,predicate){
 const start=Date.now();while(Date.now()-start<180000){const result=await call(channel,path,user,undefined,'GET',[200,404,425]);if(predicate(result)){timings.push(Date.now()-start);return result;}await new Promise(resolve=>setTimeout(resolve,1500));}throw Error('Synthetic rich replication timed out: '+channel+' '+path);
}
const payload=(text)=>({text,clientRequestId:randomUUID(),clientSentAt:new Date().toISOString()});
try{
 for(const source of ['vps','cloud']){
  const target=source==='vps'?'cloud':'vps';
  const group=(await call(source,'/api/groups',a,{name:'Replication check '+source,memberIds:[b.id]})).group;groups.push({source,id:group.id});
  await eventually(target,'/api/groups/'+group.id,b,r=>r.group?.members.length===2);
  const parent=(await call(source,'/api/group-messages',a,{...payload('Group from '+source),groupId:group.id})).message;
  await eventually(target,'/api/group-messages/'+parent.id,b,r=>r.message?.text===parent.text);
  const reply=(await call(target,'/api/group-messages',b,{...payload('Reply from '+target),groupId:group.id,replyToId:parent.id})).message;
  await eventually(source,'/api/group-messages/'+reply.id,a,r=>r.message?.reply?.available===true);
  await call(target,'/api/group-messages/'+parent.id,a,{text:'Edited remotely'},'PATCH');
  await eventually(source,'/api/group-messages/'+parent.id,b,r=>r.message?.text==='Edited remotely');
  await call(target,'/api/group-messages/'+parent.id+'/reaction',b,{emoji:'👍'},'PUT');
  await eventually(source,'/api/group-messages/'+parent.id,a,r=>r.message?.reactions.some(x=>x.userId===b.id&&x.emoji==='👍'));
  const poll=(await call(source,'/api/messages',a,{...payload('Ready?'),toUserId:b.id,kind:'choice',options:[{id:'yes',label:'Да'},{id:'no',label:'Нет'}]})).message;messages.push({source,id:poll.id});
  await eventually(target,'/api/messages/'+poll.id,b,r=>r.message?.options?.length===2);
  await call(target,'/api/messages/'+poll.id+'/answer',b,{id:'yes'});
  await eventually(source,'/api/messages/'+poll.id,a,r=>r.message?.answer?.id==='yes');
  const bytes=Buffer.from('Tiny Messenger replication test\n');
  const upload=await call(source,'/api/attachments/uploads',a,{chatKind:'group',chatId:group.id,name:'replication-test.txt',size:bytes.length,contentType:'text/plain',clientRequestId:randomUUID()});
  const put=await fetch(upload.upload.url,{method:upload.upload.method,headers:upload.upload.headers,body:bytes,signal:AbortSignal.timeout(20000)});assert.ok(put.ok,'signed upload');
  await call(source,'/api/attachments/uploads/'+upload.attachment.id+'/complete',a,{});
  const fileMessage=(await call(source,'/api/group-messages',a,{...payload('File from '+source),groupId:group.id,attachmentIds:[upload.attachment.id]})).message;
  await eventually(target,'/api/group-messages/'+fileMessage.id,b,r=>r.message?.attachments?.[0]?.id===upload.attachment.id);
  const link=await call(target,'/api/attachments/'+upload.attachment.id+'/url',b);
  const download=await fetch(link.url,{signal:AbortSignal.timeout(20000)});assert.ok(download.ok);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  await call(source,'/api/groups/'+group.id+'/members',a,{userId:b.id},'DELETE');
  await eventually(target,'/api/groups/'+group.id,b,r=>r.status===404);
  assert.equal((await call(target,'/api/attachments/'+upload.attachment.id+'/url',b,undefined,'GET',[404])).status,404);
 }
 const proof={groupsBothDirections:true,quotes:true,edits:true,reactions:true,pollsAndAnswers:true,realS3UploadAndDownloadBothDirections:true,membershipRevocation:true,fileAccessRevoked:true,maxObservedReplicationMs:Math.max(...timings),requests,completedAt:new Date().toISOString()};
 await writeFile(new URL('rich-replication-proof.json',dir),JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}finally{
 for(const group of groups)try{await call(group.source,'/api/groups/'+group.id,a,{},'DELETE',[200,404]);}catch{}
 for(const message of messages)try{await call(message.source,'/api/messages/'+message.id,a,{scope:'everyone'},'DELETE',[200,404]);}catch{}
}
