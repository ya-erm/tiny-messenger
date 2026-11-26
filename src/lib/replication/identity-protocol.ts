import { parseReplicatedUser } from "./users-protocol";
export type IdentityOperation = { version: 1; id: string; userId: string; at: string } & (
  { kind: "token"; tokenHash: string; previousTokenHash: string } |
  { kind: "profile"; nicknameAt: string; profile: { name: string; nickname: string | null; avatarUrl: string | null; avatarBackground: string | null } }
);
const uuid=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const utc=(v:unknown)=>typeof v==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));
export function parseIdentityOperation(input:unknown):IdentityOperation {
 const o=input as IdentityOperation;
 if(!o||o.version!==1||!uuid(o.id)||!uuid(o.userId)||!utc(o.at)||!["token","profile"].includes(o.kind))throw Error("Invalid identity operation");
 if(o.kind==="token"){
  if(!/^[a-f0-9]{64}$/.test(o.tokenHash)||!/^[a-f0-9]{64}$/.test(o.previousTokenHash)||o.tokenHash===o.previousTokenHash)throw Error("Invalid credential change");
  return {version:1,id:o.id,userId:o.userId,at:o.at,kind:o.kind,tokenHash:o.tokenHash,previousTokenHash:o.previousTokenHash};
 }
 if(!utc(o.nicknameAt)||o.nicknameAt>o.at||!o.profile)throw Error("Invalid profile change");
 const p=o.profile;parseReplicatedUser({...p,id:o.userId,createdAt:o.at,updatedAt:o.at,tokenHash:"0".repeat(64)});
 return {version:1,id:o.id,userId:o.userId,at:o.at,kind:o.kind,nicknameAt:o.nicknameAt,profile:{name:p.name,nickname:p.nickname||null,avatarUrl:p.avatarUrl||null,avatarBackground:p.avatarBackground||null}};
}
export const identityOrder=(o:{at:string;id:string})=>o.at+"|"+o.id;
export function nextIdentityTime(previous?:{at:string}) {return new Date(Math.max(Date.now(),previous?Date.parse(previous.at)+1:0)).toISOString();}
// Adapter interface is shared by SQLite and YDB. The caller owns the transaction.
export async function applyIdentityOperation(tx:any,input:unknown) {
 const operation=parseIdentityOperation(input),saved=await tx.get("identity-operations",operation.id);
 if(saved){if(JSON.stringify(saved)!==JSON.stringify(operation))throw Error("Identity operation ID conflict");return false;}
 const user=await tx.get("users",operation.userId);if(!user)throw Error("Identity user missing");
 const state=await tx.get("identity-state",user.id)||{},previous=state[operation.kind];
 await tx.put("identity-operations",operation.id,operation);
 if(previous&&identityOrder(previous)>=identityOrder(operation))return false;
 state[operation.kind]=operation;await tx.put("identity-state",user.id,state);
 const updated={...user,updatedAt:user.updatedAt>operation.at?user.updatedAt:operation.at};
 if(operation.kind==="token"){updated.tokenHash=operation.tokenHash;await tx.put("tokens",operation.tokenHash,{userId:user.id});}
 else Object.assign(updated,operation.profile);
 // Clear projected nicknames first: SQLite enforces uniqueness immediately.
 if(operation.kind==="profile"){
  await reconcileIdentityNicknames(tx,updated,state);
 }else await tx.put("users",user.id,updated);
 return true;
}

export async function reconcileIdentityNicknames(tx:any,replacement?:any,replacementState?:any){
  const users=await tx.scan("users",10001);if(users.length>=10001)throw Error("Identity registry capacity");
  const states=new Map<string,any>((await tx.scanEntries("identity-state",10001)).map((item:any)=>[item.key,item.value]));
  const claims=new Map<string,any>((await tx.scanEntries("nickname-claims",10001)).map((item:any)=>[item.key,item.value]));
  const entries=[];
  for(const other of users){const s=other.id===replacement?.id?replacementState:states.get(other.id)||{};const profile=s.profile;const nickname=profile?profile.profile.nickname:other.nickname;const claim=claims.get(other.id);entries.push({user:other.id===replacement?.id?replacement:other,nickname,at:profile?.nicknameAt||(claim&&claim.nickname===nickname?claim.at:other.createdAt)});}
  const winners=new Map<string,any>();
  for(const item of entries)if(item.nickname){const old=winners.get(item.nickname);if(!old||item.at+"|"+item.user.id<old.at+"|"+old.user.id)winners.set(item.nickname,item);}
  const original=new Map<string,any>(users.map((u:any)=>[u.id,u]));
  for(const item of entries){const next=item.nickname&&winners.get(item.nickname)===item?item.nickname:null;const before=original.get(item.user.id);if(before.nickname&&before.nickname!==next)await tx.put("users",item.user.id,{...before,nickname:null});}
  for(const item of entries){const next={...item.user,nickname:item.nickname&&winners.get(item.nickname)===item?item.nickname:null},before=original.get(item.user.id);if(["name","nickname","avatarUrl","avatarBackground","tokenHash","updatedAt"].some(k=>(before[k]??null)!==(next[k]??null)))await tx.put("users",item.user.id,next);}
}
