const KEY="tiny-messenger:v1:pending-registration";
type Attempt={fingerprint:string;clientRequestId:string;registrationToken:string};
let pending:Attempt|undefined;
export function registrationRequest(name:string,nickname:string){
 const fingerprint=JSON.stringify({name:name.trim().replace(/\s+/g," "),nickname:nickname.trim()});
 if(!pending)try{pending=JSON.parse(sessionStorage.getItem(KEY)||"null")||undefined;}catch{}
 if(pending?.fingerprint!==fingerprint||!/^msg_[A-Za-z0-9_-]{16}$/.test(pending.registrationToken)||!/^[0-9a-f-]{36}$/.test(pending.clientRequestId)){
  const bytes=crypto.getRandomValues(new Uint8Array(12));
  pending={fingerprint,clientRequestId:crypto.randomUUID(),registrationToken:"msg_"+btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","")};
  try{sessionStorage.setItem(KEY,JSON.stringify(pending));}catch{}
 }
 return{clientRequestId:pending.clientRequestId,registrationToken:pending.registrationToken};
}
export function clearRegistrationRequest(){pending=undefined;try{sessionStorage.removeItem(KEY);}catch{}}
