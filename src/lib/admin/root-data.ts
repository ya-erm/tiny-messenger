import "server-only";
import type {PrismaClient} from "@/generated/prisma/client";
import type {AdminRow} from "./data";
export async function rootAdminRows(db:PrismaClient):Promise<AdminRow[]> {
  const messages=await db.$queryRawUnsafe<AdminRow[]>(`SELECT 'Message' bucket,id,fromUserId,toUserId,NULL groupId,sentAt at FROM Message UNION ALL SELECT 'GroupMessage',id,fromUserId,NULL,groupId,sentAt FROM GroupMessage LIMIT 20001`);
  const rows=await db.$queryRawUnsafe<AdminRow[]>(`SELECT 'rows:'||tableName bucket,json_extract(body,'$.data.id') id,json_extract(body,'$.data.fromUserId') fromUserId,json_extract(body,'$.data.toUserId') toUserId,json_extract(body,'$.data.groupId') groupId,COALESCE(json_extract(body,'$.data.userId'),json_extract(body,'$.data.uploaderId')) userId,json_extract(body,'$.data.sentAt') at,json_extract(body,'$.data.status') status,json_extract(body,'$.data.messageId') messageId,json_extract(body,'$.data.groupMessageId') groupMessageId,COALESCE(json_extract(body,'$.data.confirmedSize'),json_extract(body,'$.data.requestedSize')) size,json_extract(body,'$.deletedVersion') deletedVersion,json_extract(body,'$.aliveVersion') aliveVersion FROM ReplicaRow WHERE tableName IN ('Message','GroupMessage','GroupMember','Attachment') LIMIT 20001`);
  const native=await db.$queryRawUnsafe<AdminRow[]>(`SELECT 'operations' bucket,'message.create' opType,json_extract(body,'$.message.id') id,json_extract(body,'$.message.fromUserId') fromUserId,json_extract(body,'$.message.toUserId') toUserId,json_extract(body,'$.message.sentAt') at FROM MutationOperation WHERE type='message.create' LIMIT 20001`);
  const devices=await db.$queryRawUnsafe<AdminRow[]>(`SELECT 'device-telemetry' bucket,json_extract(body,'$.userId') userId,json_extract(body,'$.lastSeenAt') lastSeenAt FROM ReplicationState WHERE key LIKE 'device-telemetry:%' LIMIT 20001`);
  const contacts=await db.contact.findMany({select:{ownerId:true,userId:true},take:20001});
  const files=await db.attachment.findMany({select:{id:true,uploaderId:true,messageId:true,groupMessageId:true,status:true,confirmedSize:true,requestedSize:true},take:20001});
  // Current SQL rows supersede replicated projections; native IDs are deduplicated.
  return [...rows,...messages,...native,...devices,...contacts.map(row=>({bucket:"Contact",...row})),...files.map(row=>({bucket:"Attachment",id:row.id,status:row.status,messageId:row.messageId||undefined,groupMessageId:row.groupMessageId||undefined,userId:row.uploaderId,size:Number(row.confirmedSize??row.requestedSize)}))];
}
