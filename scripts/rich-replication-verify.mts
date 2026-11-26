import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { prisma, write, read } from "../src/lib/db";
import { synchronizeInstallations } from "../src/lib/replication/synchronize";
import { memoryStore } from "../cloud/yandex/tests/memory-store.mjs";
import { createService } from "../cloud/yandex/src/service.mjs";
import { createFileService } from "../cloud/yandex/src/row-files.mjs";
import { createReplication } from "../cloud/yandex/src/replication.mjs";
import { createHandler } from "../cloud/yandex/src/handler.mjs";
import { POST as createGroup } from "../src/app/api/groups/route";
import { PATCH as editGroup } from "../src/app/api/groups/[id]/route";
import { POST as addMember } from "../src/app/api/groups/[id]/members/route";
import { POST as createGroupMessage } from "../src/app/api/group-messages/route";
import { POST as createMessage } from "../src/app/api/messages/route";
import { POST as answer } from "../src/app/api/messages/[id]/answer/route";
import { DELETE as deleteMessage } from "../src/app/api/messages/[id]/route";
import { acceptMutation } from "../src/lib/mutations/accept";
const temporary = await mkdtemp(tmpdir()+"/tm-rich-");
const now = new Date().toISOString();
const tokens = [randomUUID(),randomUUID(),randomUUID(),randomUUID()];
const users = tokens.map((token,index)=>({id:randomUUID(),name:"Rich "+index,tokenHash:createHash("sha256").update(token).digest("hex"),createdAt:now,updatedAt:now}));
const db=memoryStore(),cloud=createService(db,"rich-cloud");
const config={TM_INSTALLATION_ID:"rich-cloud",TM_REPLICATION_PEER:"test-vps",TM_REPLICATION_SECRET:"x".repeat(64)};
cloud.exchange=createReplication(db,cloud,config);
const objects=new Map();
cloud.files=createFileService(cloud.rows,{
 async signedUpload(id,key,size,contentType,expiresAt){objects.set(key,{ContentLength:size,ContentType:contentType,Metadata:{"upload-id":id},ETag:'"source"'});return{url:"https://objects.example/"+key,method:"PUT",headers:{},expiresAt};},
 async headAttachment(id,key){return objects.get(key)||null;},
 async freezeAttachment(id,from,to,etag,contentType){objects.set(to,{...objects.get(from),ContentType:contentType,ETag:'"final"',Metadata:{"upload-id":id,"source-etag":etag.replaceAll('"','')}});},
 async signedDownload(id,key){return{url:"https://objects.example/"+key,expiresAt:new Date(Date.now()+120000).toISOString()};},
});
const handler=createHandler(async()=>cloud,config);
function request(body:any,who=0,method="POST"){return new Request("https://vps.example/api/test",{method,headers:{authorization:"Bearer "+tokens[who],"content-type":"application/json"},body:JSON.stringify(body)});}
async function local(handler:any,body:any,who=0,id?:string,method="POST",expected=200){const response=await handler(request(body,who,method),{params:Promise.resolve({id})});const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value.error));return value.data;}
async function remote(method:string,path:string,body:any,who=0,expected=200){const response=await handler({httpMethod:method,path,headers:{authorization:"Bearer "+tokens[who]},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=JSON.parse(response.body);assert.equal(response.statusCode,expected,JSON.stringify(value.error));return value.data;}
async function force(){await write(async tx=>{const key="peer:rich-cloud",old=await tx.replicationState.findUnique({where:{key}});if(old){const state=JSON.parse(old.body);state.nextPoll=0;state.retryAt=0;await tx.replicationState.update({where:{key},data:{body:JSON.stringify(state)}});}});const value=await synchronizeInstallations() as any;assert.equal(value.error,undefined,JSON.stringify(value));return value;}
async function drain(){for(let i=0;i<100;i++){const value=await force();if(!value.sent&&!value.sentRows&&!value.received&&!value.directoryItems)return;}throw Error("Rich sync did not converge");}
const originalFetch=globalThis.fetch;
try{
 await write(async tx=>{for(const user of users)await tx.user.create({data:user});});
 await writeFile(temporary+"/bootstrap.json",JSON.stringify({formatVersion:1,createdAt:now,messages:[],operations:[],deletions:[]}));
 await writeFile(temporary+"/config.json",JSON.stringify({url:"https://rich.example/api/internal/replication/exchange",secret:config.TM_REPLICATION_SECRET,peerId:"rich-cloud",installationId:"test-vps",bootstrapFile:temporary+"/bootstrap.json"}));
 process.env.TM_REPLICATION_CONFIG=temporary+"/config.json";
 process.env.ATTACHMENTS_S3_BUCKET="test-files";process.env.ATTACHMENTS_S3_ACCESS_KEY_ID="test";process.env.ATTACHMENTS_S3_SECRET_ACCESS_KEY="test-secret";
 globalThis.fetch=(async(url,init)=>{assert.equal(String(url),"https://rich.example/api/internal/replication/exchange");const response=await handler({httpMethod:"POST",path:"/api/internal/replication/exchange",headers:init?.headers,body:init?.body});return new Response(response.body,{status:response.statusCode});}) as typeof fetch;
 await drain();
 const created=await local(createGroup,{name:"Shared group",memberIds:[users[1].id,users[2].id]},0,undefined,"POST",201);const gid=created.group.id;
 await drain();assert.equal((await remote("GET","/api/groups/"+gid,undefined,1)).group.members.length,3);
 // Concurrent edits of independent columns and membership rows must survive.
 await local(editGroup,{name:"Renamed on VPS"},0,gid,"PATCH");
 await remote("PATCH","/api/groups/"+gid,{avatarBackground:"#112233"});
 await local(addMember,{userId:users[3].id},0,gid);
 await remote("DELETE","/api/groups/"+gid+"/members",{userId:users[2].id});
 await drain();
 const common=(await remote("GET","/api/groups/"+gid,undefined)).group;
 assert.equal(common.name,"Renamed on VPS");assert.equal(common.avatarBackground,"#112233");assert.deepEqual(new Set(common.members.map((m:any)=>m.id)),new Set([users[0].id,users[1].id,users[3].id]));
 const localGroup=await read(db=>db.group.findUniqueOrThrow({where:{id:gid}}));assert.equal(localGroup.name,common.name);assert.equal(localGroup.avatarBackground,common.avatarBackground);
 await remote("GET","/api/groups/"+gid,undefined,2,404);
 const groupMessage=(await local(createGroupMessage,{groupId:gid,text:"Group from VPS",clientRequestId:randomUUID()},0,undefined,"POST",201)).message;
 await drain();assert.equal((await remote("GET","/api/group-messages/"+groupMessage.id,undefined,1)).message.text,"Group from VPS");
 await remote("PATCH","/api/group-messages/"+groupMessage.id,{text:"Forbidden"},1,403);
 await remote("PUT","/api/group-messages/"+groupMessage.id+"/reaction",{emoji:"👍"},1);
 await remote("PATCH","/api/group-messages/"+groupMessage.id,{text:"Edited from cloud"});await drain();
 assert.equal((await read(db=>db.groupMessage.findUniqueOrThrow({where:{id:groupMessage.id}}))).text,"Edited from cloud");
 assert.equal(await read(db=>db.groupMessageReaction.count({where:{messageId:groupMessage.id,userId:users[1].id}})),1);
 const reply=(await remote("POST","/api/group-messages",{groupId:gid,text:"Cloud reply",replyToId:groupMessage.id,clientRequestId:randomUUID()},1,201)).message;
 assert.equal(reply.reply.available,true);await drain();assert.equal(await read(db=>db.groupMessage.count({where:{id:reply.id}})),1);
 await remote("DELETE","/api/group-messages/"+groupMessage.id,{scope:"everyone"},1,403);
 await remote("DELETE","/api/group-messages/"+groupMessage.id,{scope:"me"},1);await drain();
 assert.equal(await read(db=>db.groupMessageDeletion.count({where:{messageId:groupMessage.id,userId:users[1].id}})),1);
 await remote("GET","/api/group-messages/"+groupMessage.id,undefined,1,404);
 assert.equal((await remote("GET","/api/group-messages/"+reply.id,undefined,1)).message.reply.available,false);
 const poll=(await local(createMessage,{toUserId:users[1].id,kind:"choice",text:"Ready?",options:[{id:"yes",label:"Да"},{id:"no",label:"Нет"}],clientRequestId:randomUUID()},0,undefined,"POST",201)).message;
 await drain();assert.equal((await remote("GET","/api/messages/"+poll.id,undefined,1)).message.options.length,2);
 await local(answer,{id:"yes"},1,poll.id);await remote("POST","/api/messages/"+poll.id+"/answer",{id:"no"},1);await drain();
 assert.equal((await remote("GET","/api/messages/"+poll.id,undefined,1)).message.answer.id,"yes");
 assert.equal((await read(db=>db.message.findUniqueOrThrow({where:{id:poll.id}}))).answerId,"yes");
 await remote("POST","/api/messages/"+poll.id+"/answer",{id:"no"},1,409);
 // A quote may target a native v1 message. Deletion removes its preview.
 const originalId=randomUUID();await write(tx=>acceptMutation(tx,{protocolVersion:1,operationId:randomUUID(),actorId:users[0].id,deviceId:randomUUID(),occurredAt:now,type:"message.create",message:{id:originalId,fromUserId:users[0].id,toUserId:users[1].id,text:"Quoted secret",kind:"text",sentAt:now}},users[0]));await drain();
 await remote("PATCH","/api/messages/"+originalId,{text:"Native edit via legacy endpoint"});
 await remote("PUT","/api/messages/"+originalId+"/reaction",{emoji:"👍"},1);await drain();
 assert.equal((await read(db=>db.message.findUniqueOrThrow({where:{id:originalId}}))).text,"Native edit via legacy endpoint");
 assert.equal(await read(db=>db.messageReaction.count({where:{messageId:originalId,userId:users[1].id}})),1);
 const quoted=(await remote("POST","/api/messages",{toUserId:users[0].id,text:"Quote from cloud",kind:"text",replyToId:originalId,clientRequestId:randomUUID()},1,201)).message;
 assert.equal(quoted.reply.available,true);await drain();
 await local(deleteMessage,{scope:"everyone"},0,originalId,"DELETE");await drain();assert.equal((await remote("GET","/api/messages/"+quoted.id,undefined,1)).message.reply.available,false);
 // Real file workflow with isolated object storage double; no file bytes or
 // production credentials are used in this integration test.
 const upload=await remote("POST","/api/attachments/uploads",{chatKind:"peer",chatId:users[1].id,name:"test.png",size:120000,thumbnailSize:12000,contentType:"image/png",clientRequestId:randomUUID()},0,201);
 const completed=await remote("POST","/api/attachments/uploads/"+upload.attachment.id+"/complete",{},0);assert.equal(completed.attachment.id,upload.attachment.id);assert.equal(completed.attachment.hasThumbnail,true);
 const fileMessage=(await remote("POST","/api/messages",{toUserId:users[1].id,text:"File",kind:"text",attachmentIds:[upload.attachment.id],clientRequestId:randomUUID()},0,201)).message;
 assert.equal(fileMessage.attachments.length,1);await drain();
 const onVps=await read(db=>db.attachment.findUniqueOrThrow({where:{id:upload.attachment.id}}));assert.equal(onVps.status,"attached");assert.equal(onVps.messageId,fileMessage.id);assert.equal(onVps.thumbnailSize,12000n);assert.ok(onVps.thumbnailKey?.endsWith(".thumbnail.webp"));assert.equal(onVps.reservedBytes,132000n);
 assert.match((await remote("GET","/api/attachments/"+upload.attachment.id+"/url?mode=preview",undefined,1)).url,/objects\.example/);
 assert.ok((await remote("GET","/api/attachments/"+upload.attachment.id+"/url?mode=thumbnail",undefined,1)).url.endsWith(".thumbnail.webp"));
 await remote("GET","/api/attachments/"+upload.attachment.id+"/url?mode=thumbnail",undefined,2,404);
 await remote("GET","/api/attachments/"+upload.attachment.id+"/url",undefined,2,404);
 await remote("POST","/api/attachments/uploads",{chatKind:"peer",chatId:users[0].id,name:"hijack.png",size:12,contentType:"image/png",clientRequestId:upload.attachment.id},1,409);
 const queuedEdit={protocolVersion:1,operationId:randomUUID(),actorId:users[0].id,deviceId:randomUUID(),occurredAt:new Date().toISOString(),type:"message.edit",message:{id:fileMessage.id,fromUserId:users[0].id,toUserId:users[1].id,kind:"text",text:"Edited through durable queue",sentAt:fileMessage.sentAt}};
 assert.equal((await remote("POST","/api/mutations",queuedEdit,0,201)).status,"applied");
 assert.equal((await remote("POST","/api/mutations",Object.fromEntries(Object.entries(queuedEdit).reverse()))).replayed,true);
 await remote("POST","/api/mutations",{...queuedEdit,message:{...queuedEdit.message,text:"Collision"}},0,409);
 await drain();assert.equal((await read(db=>db.message.findUniqueOrThrow({where:{id:fileMessage.id}}))).text,"Edited through durable queue");
 await remote("POST","/api/mutations",{...queuedEdit,operationId:randomUUID(),type:"reaction.set",message:undefined,reaction:{messageId:fileMessage.id,userId:users[1].id,emoji:"👍"}},1,422);
 const queuedReaction={protocolVersion:1,operationId:randomUUID(),actorId:users[1].id,deviceId:randomUUID(),occurredAt:new Date().toISOString(),type:"reaction.set",reaction:{messageId:fileMessage.id,userId:users[1].id,emoji:"👍"}};
 await remote("POST","/api/mutations",queuedReaction,1,201);await drain();
 assert.equal(await read(db=>db.messageReaction.count({where:{messageId:fileMessage.id,userId:users[1].id}})),1);
 const queuedDelete={protocolVersion:1,operationId:randomUUID(),actorId:users[0].id,deviceId:randomUUID(),occurredAt:new Date().toISOString(),type:"message.delete",deletion:{messageId:fileMessage.id,scope:"everyone"}};
 await remote("POST","/api/mutations",queuedDelete,0,201);assert.equal((await remote("POST","/api/mutations",queuedDelete)).replayed,true);await drain();
 await remote("GET","/api/attachments/"+upload.attachment.id+"/url",undefined,1,404);
 console.log(JSON.stringify({groupsBidirectional:true,independentFieldConflicts:true,membershipAndRevocation:true,groupMessagesAndQuotes:true,reactionsAndPrivateDeletion:true,pollAnswerConvergence:true,nativeQuotePrivacy:true,fileUploadAndMetadata:true,fileAccessControl:true,richClientQueueEditsReactionsDeletion:true}));
}finally{globalThis.fetch=originalFetch;await prisma.$disconnect();await rm(temporary,{recursive:true,force:true});}
