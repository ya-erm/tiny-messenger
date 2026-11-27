// Synthetic differential fixtures. No production credentials or user data.
import {memoryStore} from './memory-store.mjs';
import {createService} from '../src/service.mjs';
import {createHandler} from '../src/handler.mjs';
import {createHash} from 'node:crypto';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=v=>createHash('sha256').update(v).digest('hex');
const database=memoryStore(),seed=[],steps=[];
const at=new Date(Date.now()-3600000).toISOString();
for(let i=1;i<=3;i++){
 const token='msg_'+String(i).repeat(16),user={id:id(i),name:['Автор','Получатель','Посторонний'][i-1],tokenHash:hash(token),createdAt:at,updatedAt:at};
 for(const [bucket,key,value]of [['users',user.id,user],['tokens',hash(token),{userId:user.id}]]){seed.push({bucket,key,value});await database.transaction(tx=>tx.put(bucket,key,value));}
}
const config={TM_INSTALLATION_ID:'test-cloud',TM_ALLOWED_ORIGINS:'https://tm.example',TM_ADMIN_USER_IDS:id(1)};
const service=createService(database,'test-cloud',{yandex:{clientId:'',clientSecret:'',sessionKey:'',origins:[]}}),handler=createHandler(async()=>service,config);
async function call(method,path,body,actor=1,headers={}){
 const event={httpMethod:method,url:path,headers:{authorization:'Bearer msg_'+String(actor).repeat(16),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})};
 const response=await handler(event);steps.push({event,expected:{status:response.statusCode,body:response.body?JSON.parse(response.body):null}});return response;
}
await call('GET','/api/health');await call('GET','/api/transport');await call('GET','/api/config');
await call('OPTIONS','/api/me',undefined,1,{origin:'https://tm.example'});await call('GET','/api/me',undefined,1,{origin:'https://evil.example'});
await call('GET','/api/me');await call('GET','/api/me',undefined,1,{authorization:''});await call('POST','/api/auth/session',{token:'msg_'+ '2'.repeat(16)});
await call('POST','/api/contacts',{userId:id(2)});await call('GET','/api/contacts');await call('POST','/api/sync',{});
const operation={protocolVersion:1,operationId:id(10),actorId:id(1),deviceId:id(4),occurredAt:at,type:'message.create',message:{id:id(11),fromUserId:id(1),toUserId:id(2),kind:'text',text:'Привет <>& \u2028 👩🏽‍💻',sentAt:at}};
await call('POST','/api/mutations',operation);await call('POST','/api/mutations',operation);await call('POST','/api/mutations',{...operation,message:{...operation.message,text:'Конфликт'}});await call('GET','/api/messages/'+id(11),undefined,2);await call('GET','/api/messages/'+id(11),undefined,3);
await call('PUT','/api/messages/'+id(11)+'/reaction',{emoji:'👩🏽‍💻'},2);await call('PATCH','/api/messages/'+id(11),{text:'Редакция'});await call('PATCH','/api/messages/'+id(11)+'/status',{status:'read'},2);await call('POST','/api/sync',{});await call('POST','/api/changes',{cursor:'other:0'});
await call('POST','/api/messages',{toUserId:id(2),kind:'choice',text:'Выбор',options:[{id:'a',label:'Да'},{id:'b',label:'Нет'}],clientRequestId:id(20),clientSentAt:at});await call('POST','/api/messages/'+id(20)+'/answer',{id:'a'},2);await call('POST','/api/messages/'+id(20)+'/answer',{id:'b'},2);await call('PUT','/api/messages/'+id(20)+'/reaction',{emoji:'👍🏿'},2);
await call('POST','/api/messages',{toUserId:id(2),text:'Цитата',replyToId:id(11),clientRequestId:id(21),clientSentAt:at});await call('POST','/api/messages',{toUserId:id(2),text:'Цитата',replyToId:id(11),clientRequestId:id(21),clientSentAt:at});await call('PATCH','/api/messages/'+id(21),{text:'Новая цитата'});await call('GET','/api/messages/'+id(21));
await call('POST','/api/groups',{name:'Группа',memberIds:[id(2)]},1,{'x-tm-request-id':id(30)});await call('GET','/api/groups/'+id(30),undefined,2);await call('GET','/api/groups/'+id(30),undefined,3);await call('POST','/api/group-messages',{groupId:id(30),text:'В группе',clientRequestId:id(31),clientSentAt:at});await call('PUT','/api/group-messages/'+id(31)+'/reaction',{emoji:'❤️'},2);await call('PATCH','/api/group-messages/'+id(31)+'/status',{status:'read'},2);await call('POST','/api/group-messages',{groupId:id(30),text:'Ответ в группе',replyToId:id(31),clientRequestId:id(32),clientSentAt:at});await call('GET','/api/group-messages?groupId='+id(30),undefined,2);await call('PATCH','/api/groups/'+id(30),{name:'Новая группа'});await call('POST','/api/groups/'+id(30)+'/members',{userId:id(3)});await call('DELETE','/api/groups/'+id(30)+'/members',{userId:id(3)});await call('POST','/api/sync',{});
await call('GET','/api/admin/access');await call('GET','/api/admin/access',undefined,2);await call('GET','/api/admin/users',undefined,2);
await call('POST','/api/client/telemetry',{id:id(40),deviceId:id(41),sessionId:id(42),sequence:1,at,mode:'auto',channel:'yandex-1',reason:'startup',latencyMs:120,browser:'Chrome',platform:'macOS',pwa:true,appVersion:'v0.18.0',origin:'https://tm.example'});
await call('GET','/api/admin/users');await call('GET','/api/admin/devices?userId='+id(1));
await call('DELETE','/api/messages/'+id(21),{scope:'me'},2);await call('GET','/api/messages/'+id(21),undefined,2);await call('GET','/api/messages/'+id(21));await call('DELETE','/api/messages/'+id(11),{scope:'everyone'},2);await call('POST','/api/sync',{},2);
await call('PATCH','/api/me',{name:'Новое имя',nickname:'go-test'});await call('GET','/api/me');
await call('POST','/api/me/token',{operationId:id(50),replacementToken:'msg_'+ '4'.repeat(16),changedAt:new Date().toISOString()});await call('GET','/api/me');await call('GET','/api/me',undefined,4);
await call('POST','/api/auth/register',{name:'Новый',clientRequestId:id(60),registrationToken:'msg_'+ '6'.repeat(16)});await call('POST','/api/auth/register',{name:'Новый',clientRequestId:id(60),registrationToken:'msg_'+ '6'.repeat(16)});await call('POST','/api/auth/register',{name:'Другой',clientRequestId:id(60),registrationToken:'msg_'+ '6'.repeat(16)});
console.log(JSON.stringify({seed,steps,config}));
