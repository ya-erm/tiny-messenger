export interface ReplicatedUser { id:string; name:string; nickname?:string|null; avatarUrl?:string|null; avatarBackground?:string|null; tokenHash:string; createdAt:string; updatedAt:string }
const uuid=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const utc=(value:unknown)=>typeof value==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
export function parseReplicatedUser(input:unknown):ReplicatedUser {
 const v=input as ReplicatedUser;
 if(!v||!uuid(v.id)||typeof v.name!=="string"||Array.from(v.name).length<1||Array.from(v.name).length>20||!utc(v.createdAt)||!utc(v.updatedAt)||!/^([0-9a-f]{64})$/.test(v.tokenHash)
 ||v.nickname!=null&&(typeof v.nickname!=="string"||!/^[a-z0-9_.-]{1,32}$/.test(v.nickname))
 ||v.avatarUrl!=null&&(typeof v.avatarUrl!=="string"||v.avatarUrl.length>500||!/^https?:\/\//.test(v.avatarUrl))
 ||v.avatarBackground!=null&&(typeof v.avatarBackground!=="string"||!/^#[0-9a-f]{6}$/i.test(v.avatarBackground)))throw Error("Invalid replicated user");
 return Object.fromEntries(["id","name","nickname","avatarUrl","avatarBackground","tokenHash","createdAt","updatedAt"].filter(k=>(v as any)[k]!==undefined).map(k=>[k,(v as any)[k]])) as unknown as ReplicatedUser;
}
export function nicknameClaimOrder(at:string,id:string){return at+"|"+id;}
export interface ContactOperation { id:string; ownerId:string; userId:string; at:string; createdAt:string; deleted:boolean }
export function parseContactOperation(value:unknown):ContactOperation {
 const v=value as ContactOperation;
 if(!v||![v.id,v.ownerId,v.userId].every(uuid)||v.ownerId===v.userId||!utc(v.at)||!utc(v.createdAt)||typeof v.deleted!=="boolean")throw Error("Invalid contact operation");return v;
}
