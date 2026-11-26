import {dayAt,shiftDay,type AdminRange} from "./time";
export interface AdminRow {bucket:string;id?:string;fromUserId?:string;toUserId?:string;groupId?:string;userId?:string;ownerId?:string;at?:string;lastSeenAt?:string;opType?:string;status?:string;messageId?:string;groupMessageId?:string;size?:number|string;deletedVersion?:string;aliveVersion?:string;contacts?:string|any[]}
export interface AdminUser {id:string;name:string;nickname:string|null;avatarUrl:string|null;avatarBackground:string|null;createdAt:string;lastSeenAt:string|null;counters:{chats:number;messages:number;attachments:number;attachmentBytes:number};daily:Array<{day:string;count:number}>}
export function projectAdminRow(bucket:string,value:any,key=""):AdminRow {
 const data=bucket==="operations"?value.operation?.message:bucket==="states"?value.archive:value.data||value;
 const row:AdminRow={bucket,...Object.fromEntries(["id","fromUserId","toUserId","groupId","userId","ownerId","messageId","groupMessageId","status","lastSeenAt"].map(field=>[field,data?.[field]])),at:data?.sentAt,opType:value.operation?.type,size:data?.confirmedSize??data?.requestedSize,deletedVersion:value.deletedVersion,aliveVersion:value.aliveVersion};
 if(bucket==="rows:Attachment"||bucket==="Attachment")row.userId=data?.uploaderId;
 if(bucket==="user-state"){row.userId=key;row.contacts=value.contacts||[];}
 return row;
}
export function summarizeAdmin(users:any[],records:AdminRow[],options:{timeZone?:string;range?:AdminRange}={}) {
 const files=new Map<string,AdminRow>(),messages=new Map<string,AdminRow>(),chats=new Map<string,Set<string>>();
 const timeZone=options.timeZone||"UTC",today=dayAt(Date.now(),timeZone),windowStart=shiftDay(today,-365);
 const result:AdminUser[]=users.map(user=>({id:user.id,name:user.name,nickname:user.nickname||null,avatarUrl:user.avatarUrl||null,avatarBackground:user.avatarBackground||null,createdAt:user.createdAt,lastSeenAt:null,counters:{chats:0,messages:0,attachments:0,attachmentBytes:0},daily:[]}));
 const byId=new Map(result.map(user=>[user.id,user])),daily=new Map<string,Map<string,number>>();
 const chat=(userId:string|undefined,id:string)=>{if(!userId||!byId.has(userId))return;let set=chats.get(userId);if(!set)chats.set(userId,set=new Set());set.add(id);};
 const seen=(userId:string|undefined,at:string|undefined)=>{const user=userId&&byId.get(userId);if(user&&at&&Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.now()+300000&&(!user.lastSeenAt||at>user.lastSeenAt))user.lastSeenAt=at;};
 for(const row of records){
  if(["rows:Message","rows:GroupMessage","states","operations","Message","GroupMessage"].includes(row.bucket)){
   if(row.bucket==="operations"&&row.opType!=="message.create")continue;
   if(row.id&&row.fromUserId&&row.at&&Number.isFinite(Date.parse(row.at)))messages.set((row.groupId?"g:":"m:")+row.id,row);
  }else if(row.bucket==="device-telemetry")seen(row.userId,row.lastSeenAt);
  else if(row.bucket==="rows:GroupMember"||row.bucket==="GroupMember"){
   if(!row.deletedVersion||row.deletedVersion<(row.aliveVersion||""))chat(row.userId,"g:"+row.groupId);
  }else if(row.bucket==="Contact")chat(row.ownerId,"m:"+row.userId);
  else if(row.bucket==="user-state"){
   let contacts:any[]=[];try{contacts=typeof row.contacts==="string"?JSON.parse(row.contacts):row.contacts||[];}catch{}
   for(const item of contacts)if(typeof item.userId==="string")chat(row.userId,"m:"+item.userId);
  }else if(row.bucket==="rows:Attachment"||row.bucket==="Attachment"){
   if(row.id)files.set(row.id,row);
  }
 }
 for(const row of files.values()){const user=row.userId&&byId.get(row.userId);if(user&&(row.messageId||row.groupMessageId)&&row.status!=="deleted"){user.counters.attachments++;user.counters.attachmentBytes+=Number(row.size)||0;}}
 for(const row of messages.values()){
  const sender=byId.get(row.fromUserId!);if(sender){sender.counters.messages++;seen(sender.id,row.at);const day=dayAt(row.at!,timeZone);if(day>=windowStart&&day<=today&&(!options.range||row.at!>=options.range.from&&row.at!<=options.range.to)){let days=daily.get(sender.id);if(!days)daily.set(sender.id,days=new Map());days.set(day,(days.get(day)||0)+1);}}
  if(row.groupId)chat(row.fromUserId,"g:"+row.groupId);else{if(row.toUserId){chat(row.fromUserId,"m:"+row.toUserId);chat(row.toUserId,"m:"+row.fromUserId);}}
 }
 for(const user of result){user.counters.chats=chats.get(user.id)?.size||0;user.daily=[...(daily.get(user.id)||new Map())].map(([day,count])=>({day,count})).sort((a,b)=>a.day.localeCompare(b.day));}
 return {users:result.sort((a,b)=>(b.lastSeenAt||b.createdAt).localeCompare(a.lastSeenAt||a.createdAt)),timeZone,range:options.range||null,windowStart,today,generatedAt:new Date().toISOString()};
}
