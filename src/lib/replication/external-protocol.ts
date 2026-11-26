export interface ExternalLinkOperation {version:1;id:string;userId:string;subjectHash:string;provider:"yandex";at:string;deleted:boolean;label:string}
const uuid=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const externalOrder=(o:ExternalLinkOperation)=>o.at+"|"+o.id;
export function parseExternalLink(input:any):ExternalLinkOperation{
 if(!input||input.version!==1||input.provider!=="yandex"||!uuid(input.id)||!uuid(input.userId)||!/^[a-f0-9]{64}$/.test(input.subjectHash)||typeof input.at!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.at)||!Number.isFinite(Date.parse(input.at))||typeof input.deleted!=="boolean"||typeof input.label!=="string"||input.label.length>80)throw Error("Invalid external identity operation");
 return Object.fromEntries(["version","id","userId","subjectHash","provider","at","deleted","label"].map(k=>[k,input[k]])) as unknown as ExternalLinkOperation;
}
export async function applyExternalLink(tx:any,input:unknown){
 const operation=parseExternalLink(input),receipt=await tx.get("external-operations",operation.id);
 if(receipt){if(JSON.stringify(receipt)!==JSON.stringify(operation))throw Error("External identity operation ID conflict");return false;}
 if(!await tx.get("users",operation.userId))throw Error("External identity user missing");
 const current=await tx.get("external-users",operation.userId),subject=await tx.get("external-subjects",operation.subjectHash)||{claims:{}};
 const old=subject.claims[operation.userId];
 if(!old||externalOrder(operation)>externalOrder(old)){subject.claims[operation.userId]=operation;await tx.put("external-subjects",operation.subjectHash,subject);}
 if(!current||externalOrder(operation)>externalOrder(current))await tx.put("external-users",operation.userId,operation);
 await tx.put("external-operations",operation.id,operation);return true;
}
export async function externalOwners(tx:any,subjectHash:string):Promise<string[]>{
 const subject=await tx.get("external-subjects",subjectHash),owners:string[]=[];
 for(const input of Object.values(subject?.claims||{})){const claim=parseExternalLink(input);if(claim.deleted)continue;const current=await tx.get("external-users",claim.userId);if(current?.id===claim.id&&!current.deleted)owners.push(claim.userId);}
 return owners.sort();
}
