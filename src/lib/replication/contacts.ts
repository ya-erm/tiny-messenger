import type { Prisma } from "@/generated/prisma/client";
import { parseContactOperation, type ContactOperation } from "./users-protocol";
export async function recordContactVersion(tx:Prisma.TransactionClient,operation:ContactOperation){
 const key="contact:"+operation.ownerId+":"+operation.userId,body=JSON.stringify(operation);
 await tx.replicationState.upsert({where:{key},create:{key,body},update:{body}});
}
export async function importPeerContact(tx:Prisma.TransactionClient,input:unknown){
 const operation=parseContactOperation(input),key="contact:"+operation.ownerId+":"+operation.userId;
 const [old,contact]=await Promise.all([tx.replicationState.findUnique({where:{key}}),tx.contact.findUnique({where:{ownerId_userId:{ownerId:operation.ownerId,userId:operation.userId}}})]);
 const previous=old?JSON.parse(old.body):contact?{at:contact.updatedAt,id:""}:undefined;
 if(previous&&previous.at+"|"+previous.id>=operation.at+"|"+operation.id)return;
 if(!await tx.user.findUnique({where:{id:operation.ownerId}})||!await tx.user.findUnique({where:{id:operation.userId}}))throw Error("Contact dependencies missing");
 const where={ownerId_userId:{ownerId:operation.ownerId,userId:operation.userId}};
 if(operation.deleted)await tx.contact.deleteMany({where:{ownerId:operation.ownerId,userId:operation.userId}});
 else await tx.contact.upsert({where,create:{ownerId:operation.ownerId,userId:operation.userId,createdAt:operation.createdAt,updatedAt:operation.at},update:{updatedAt:operation.at}});
 await recordContactVersion(tx,operation);
}
