import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mergeRow, effectiveRowData, rowDeleted, rowKey, parseRowOperation } from "../shared/rows.mjs";
const operation=(table,patch,sequence,deleted=false,origin="vps-1")=>({version:1,id:randomUUID(),origin,sequence:String(sequence),at:"2026-11-26T09:00:00.000Z",table,key:rowKey(table,patch),patch,deleted});
function* permutations(items){if(!items.length){yield[];return;}for(let i=0;i<items.length;i++)for(const rest of permutations(items.filter((_,j)=>i!==j)))yield[items[i],...rest];}
const fold=ops=>ops.reduce((state,op)=>mergeRow(state,parseRowOperation(op)),undefined);
test("field versions converge in every order; deletion dominates late edits",()=>{
 const id=randomUUID(),events=[operation("GroupMessage",{id,text:"original",groupId:randomUUID(),fromUserId:randomUUID(),sentAt:"2026-11-26T09:00:00.000Z"},1),operation("GroupMessage",{id,text:"edited"},2),operation("GroupMessage",{id,replyToId:randomUUID()},3)];
 const expected=fold(events);for(const order of permutations(events))assert.deepEqual(fold(order),expected);
 const remove=operation("GroupMessage",{id},4,true),late=operation("GroupMessage",{id,text:"late"},5);for(const order of permutations([...events,remove,late]))assert.equal(rowDeleted(fold(order)),true);
});
test("poll answers converge to earliest answer even when creations/edits arrive late",()=>{
 const id=randomUUID(),events=[operation("Message",{id,text:"Question",answerId:null,answerLabel:null,answeredAt:null},1),operation("Message",{id,answerId:"yes",answerLabel:"Yes",answeredAt:"2026-11-26T09:00:01.000Z"},2),operation("Message",{id,answerId:"no",answerLabel:"No",answeredAt:"2026-11-26T09:00:02.000Z"},3,false,"yandex-1"),operation("Message",{id,senderName:"Name"},4)];
 for(const order of permutations(events)){const state=fold(order);assert.equal(state.data.answerId,"yes");assert.equal(state.data.answerLabel,"Yes");assert.equal(state.data.answeredAt,"2026-11-26T09:00:01.000Z");assert.equal(state.data.senderName,"Name");}
});
test("membership removals beat stale additions and later rejoin works",()=>{
 const key={groupId:randomUUID(),userId:randomUUID()},add=operation("GroupMember",key,1),remove=operation("GroupMember",key,2,true),rejoin=operation("GroupMember",key,3);
 assert.equal(rowDeleted(fold([remove,add])),true);for(const order of permutations([add,remove,rejoin]))assert.equal(rowDeleted(fold(order)),false);
});
test("an attachment accepted by an isolated peer survives an earlier cleanup status",()=>{
 const id=randomUUID(),events=[operation("Attachment",{id,status:"uploaded",messageId:null,groupMessageId:null},1),operation("Attachment",{id,status:"deleting"},2),operation("Attachment",{id,messageId:randomUUID(),status:"attached"},3,false,"yandex-1")];
 events[1].at="2026-11-26T09:00:05.000Z"; events[2].at="2026-11-26T09:00:04.000Z";
 for(const order of permutations(events))assert.equal(effectiveRowData(fold(order)).status,"attached");
 const detach=operation("Attachment",{id,messageId:null,groupMessageId:null},4);detach.at="2026-11-26T09:00:06.000Z";
 const expected=fold([...events,detach]);for(const order of permutations([...events,detach]))assert.deepEqual(fold(order),expected);
});
test("unknown columns, wrong keys and oversized payloads fail closed",()=>{
 const id=randomUUID(),base=operation("Group",{id,name:"Test"},1);
 assert.throws(()=>parseRowOperation({...base,patch:{...base.patch,sql:"unsafe"}}));
 assert.throws(()=>parseRowOperation({...base,key:JSON.stringify([randomUUID()])}));
 assert.throws(()=>parseRowOperation({...base,patch:{id,name:"a".repeat(50000)}}));
});

test("group watermarks converge by maximum value regardless of operation version",()=>{
 const key={userId:randomUUID(),chatId:randomUUID()},a=operation("ReadState",{...key,lastReadAt:"2026-11-26T09:00:05.000Z",lastDeliveredAt:null},3),b=operation("ReadState",{...key,lastReadAt:"2026-11-26T09:00:10.000Z",lastDeliveredAt:"2026-11-26T09:00:10.000Z"},2),c=operation("ReadState",{...key,lastReadAt:null,lastDeliveredAt:null},1);
 const expected=fold([a,b,c]);for(const order of permutations([a,b,c]))assert.deepEqual(fold(order),expected);assert.equal(expected.data.lastReadAt,"2026-11-26T09:00:10.000Z");
});
