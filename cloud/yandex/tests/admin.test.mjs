import test from'node:test';import assert from'node:assert/strict';import{summarizeAdmin}from'../shared/admin-data.mjs';
test('admin deduplicates replicated messages and files and returns only aggregate metadata',()=>{
 const at=new Date().toISOString(),users=[{id:'one',name:'One',createdAt:at},{id:'two',name:'Two',createdAt:at}],message={id:'m',fromUserId:'one',toUserId:'two',at},file={id:'f',userId:'one',messageId:'m',status:'attached',size:123};
 const result=summarizeAdmin(users,[{bucket:'Message',...message},{bucket:'operations',opType:'message.create',...message},{bucket:'states',...message},{bucket:'rows:Attachment',...file},{bucket:'Attachment',...file},{bucket:'device-telemetry',userId:'two',lastSeenAt:at}]);
 const one=result.users.find(user=>user.id==='one'),two=result.users.find(user=>user.id==='two');assert.deepEqual(one.counters,{chats:1,messages:1,attachments:1,attachmentBytes:123});assert.equal(one.daily[0].count,1);assert.equal(two.counters.chats,1);assert.equal(two.lastSeenAt,at);assert.ok(!JSON.stringify(result).includes('fromUserId'));
});
