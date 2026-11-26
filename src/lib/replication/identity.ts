import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { applyIdentityOperation, nextIdentityTime, type IdentityOperation } from "./identity-protocol";
export function identityStore(tx:Prisma.TransactionClient){
 const key=(bucket:string,id:string)=>bucket==="nickname-claims"?"nickname-claim:"+id:bucket+":"+id;
 return {
  async get(bucket:string,id:string){if(bucket==="users")return tx.user.findUnique({where:{id}});if(bucket==="tokens")return null;const value=await tx.replicationState.findUnique({where:{key:key(bucket,id)}});return value?JSON.parse(value.body):null;},
  async put(bucket:string,id:string,value:any){if(bucket==="tokens")return;if(bucket==="users"){const {id:_,...data}=value;await tx.user.update({where:{id},data});return;}const k=key(bucket,id),body=JSON.stringify(value);await tx.replicationState.upsert({where:{key:k},create:{key:k,body},update:{body}});},
  async scanEntries(bucket:string,limit:number){const prefix=key(bucket,"");return (await tx.replicationState.findMany({where:{key:{startsWith:prefix}},take:limit})).map(item=>({key:item.key.slice(prefix.length),value:JSON.parse(item.body)}));},
  async scan(bucket:string,limit:number){if(bucket!=="users")throw Error("Unsupported identity scan");return tx.user.findMany({take:limit});}
 };
}
export async function recordIdentity(tx:Prisma.TransactionClient,userId:string,change:any){
 const store=identityStore(tx),state=await store.get("identity-state",userId)||{};
 const operation={version:1,id:change.id||randomUUID(),userId,at:nextIdentityTime(state[change.kind]),...change} as IdentityOperation;
 await applyIdentityOperation(store,operation);
 await store.put("identity-pending",operation.id,operation);
 return operation;
}
