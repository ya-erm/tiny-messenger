const KEY="tiny-messenger:v1:pending-token-change";
type Attempt={fingerprint:string;operationId:string;replacementToken:string;changedAt:string};
async function fingerprint(token:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,"0")).join("");}
export async function pendingTokenChange(token:string,create=false){
 const digest=await fingerprint(token);let saved:Attempt|null=null;
 try{saved=JSON.parse(localStorage.getItem(KEY)||"null");}catch{}
 if(saved?.fingerprint===digest&&/^[0-9a-f-]{36}$/.test(saved.operationId)&&/^msg_[A-Za-z0-9_-]{16}$/.test(saved.replacementToken)&&typeof saved.changedAt==="string")return {operationId:saved.operationId,replacementToken:saved.replacementToken,changedAt:saved.changedAt};
 if(!create)return null;
 const bytes=crypto.getRandomValues(new Uint8Array(12)),attempt={fingerprint:digest,operationId:crypto.randomUUID(),changedAt:new Date().toISOString(),replacementToken:"msg_"+btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")};
 // Persist before sending: a reload after a lost response must be recoverable.
 localStorage.setItem(KEY,JSON.stringify(attempt));return {operationId:attempt.operationId,replacementToken:attempt.replacementToken,changedAt:attempt.changedAt};
}
export function clearTokenChange(){try{localStorage.removeItem(KEY);}catch{}}
