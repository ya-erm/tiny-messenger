import {mergeRow,rowKey,parseRowOperation} from '../shared/rows.mjs';
import {reduceMessageOperations} from '../shared/reduce.mjs';
import {applyIdentityOperation} from '../shared/identity-protocol.mjs';
import {makeWebSession,makeYandexFlow} from '../shared/yandex-protocol.mjs';
import {memoryStore} from './memory-store.mjs';
import {createHash} from 'node:crypto';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at=n=>`2026-01-01T00:00:${String(n).padStart(2,'0')}.000Z`;
const sha=v=>createHash('sha256').update(v).digest('hex');
const rows=[];let seed=7;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
for(const table of ['Message','ReadState','Attachment','GroupMember']){
 const pk=table==='ReadState'?{userId:id(1),chatId:id(2)}:table==='GroupMember'?{groupId:id(1),userId:id(2)}:{id:id(1)};
 const ops=Array.from({length:12},(_,i)=>parseRowOperation({version:1,id:id(100+i),origin:i%2?'cloud':'vps',sequence:String(i+1),at:at(i+1),table,key:rowKey(table,pk),patch:{...pk,...(table==='Message'?{text:'Текст '+i,answerId:i%3===0?'answer-'+i:null,answerLabel:'Ответ '+i,answeredAt:i%3===0?at(i):null}:table==='ReadState'?{lastReadAt:i%3===0?null:at(12-i),lastDeliveredAt:at(i)}:table==='Attachment'?{status:i%2?'deleted':'uploaded',messageId:i===4?id(2):null,thumbnailKey:null,thumbnailSize:null}:{})},deleted:i===8}));
 for(let j=0;j<12;j++){const ordered=[...ops].sort(()=>next()%3-1);let state;for(const op of ordered)state=mergeRow(state,op);rows.push({operations:ordered,expected:state});}
}
const user={id:id(1),name:'Тест',tokenHash:sha('old'),createdAt:at(0),updatedAt:at(0)};
const identity=[{version:1,id:id(51),userId:user.id,kind:'token',at:at(3),tokenHash:sha('new'),previousTokenHash:user.tokenHash},{version:1,id:id(52),userId:user.id,kind:'profile',at:at(2),nicknameAt:at(2),profile:{name:'Имя',nickname:'test',avatarUrl:null,avatarBackground:'#00FF00'}},{version:1,id:id(53),userId:user.id,kind:'token',at:at(1),tokenHash:sha('older'),previousTokenHash:user.tokenHash}];
const database=memoryStore();await database.transaction(tx=>tx.put('users',user.id,user));
for(const op of identity)await database.transaction(tx=>applyIdentityOperation(tx,op));
const identityExpected=await database.transaction(tx=>tx.get('users',user.id));
const config={clientId:'test-client',clientSecret:'synthetic',sessionKey:'a'.repeat(64),origins:['https://tm.example']};
const session=makeWebSession(user,config),flow=makeYandexFlow(config,{mode:'link',challenge:'A'.repeat(43),origin:'https://tm.example'},user);
const nativeBase={protocolVersion:1,operationId:id(70),actorId:id(1),deviceId:id(3),occurredAt:at(0),type:'message.create',message:{id:id(71),fromUserId:id(1),toUserId:id(2),kind:'text',text:'Первый',sentAt:at(0)}};
const nativeOps=[nativeBase,...[1,2].map(n=>({...nativeBase,operationId:id(71+n),occurredAt:at(n),type:'message.edit',message:{...nativeBase.message,text:'Редакция '+n}})),{protocolVersion:1,operationId:id(74),actorId:id(2),deviceId:id(3),occurredAt:at(3),type:'reaction.set',reaction:{messageId:id(71),userId:id(2),emoji:'👩🏽‍💻'}},{protocolVersion:1,operationId:id(75),actorId:id(2),deviceId:id(3),occurredAt:at(4),type:'message.delete',deletion:{messageId:id(71),scope:'everyone'}}];
const native=Array.from({length:12},()=>{const operations=[...nativeOps].sort(()=>next()%3-1),projection=reduceMessageOperations(operations);return{operations,expected:{...projection,statuses:Object.fromEntries(projection.statuses)}};});
console.log(JSON.stringify({rows,native,user,identity,identityExpected,session,flow,config}));
