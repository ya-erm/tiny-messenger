export const TELEMETRY_MODES=["auto","default","vps-1","yandex-1","vps-direct"];
export const TELEMETRY_REASONS=["startup","manual","latency","unavailable","primary","primary-restored","primary-fallback","heartbeat","resume"];
export interface ChannelObservation {id:string;userId:string;deviceId:string;sessionId:string;sequence:number;at:string;mode:string;channel:string;reason:string;latencyMs:number|null;browser:string;platform:string;pwa:boolean;appVersion:string;origin:string;receivedAt:string;installationId:string}
const uuid=(v:unknown)=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const utc=(v:unknown)=>typeof v==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));
export function parseObservation(input:any):ChannelObservation{
 if(!input||![input.id,input.userId,input.deviceId,input.sessionId].every(uuid)||!Number.isSafeInteger(input.sequence)||input.sequence<1||!utc(input.at)||!utc(input.receivedAt)||!TELEMETRY_MODES.includes(input.mode)||!TELEMETRY_MODES.includes(input.channel)||input.channel==="auto"||!TELEMETRY_REASONS.includes(input.reason)||typeof input.pwa!=="boolean"||!(input.latencyMs===null||Number.isInteger(input.latencyMs)&&input.latencyMs>=0&&input.latencyMs<=120000))throw Error("Invalid channel observation");
 for(const key of ["browser","platform","appVersion","installationId"])if(typeof input[key]!=="string"||input[key].length>64)throw Error("Invalid device metadata");
 let url:URL;try{url=new URL(input.origin);}catch{throw Error("Invalid device origin");}if(input.origin.length>200||url.origin!==input.origin||url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname)))throw Error("Invalid device origin");
 return Object.fromEntries(["id","userId","deviceId","sessionId","sequence","at","mode","channel","reason","latencyMs","browser","platform","pwa","appVersion","origin","receivedAt","installationId"].map(k=>[k,input[k]])) as unknown as ChannelObservation;
}
function order(event:ChannelObservation){return String(event.sequence).padStart(16,"0")+"|"+event.at+"|"+event.id;}
export async function storeObservation(tx:any,input:unknown,enforceDeviceLimit=false){
 const event=parseObservation(input),key=event.userId+":"+event.deviceId;
 if(!await tx.get("users",event.userId))throw Error("Telemetry user missing");
 const previous=await tx.get("device-telemetry",key);
 if(!previous){const devices=await tx.scanPrefix("device-telemetry",event.userId+":",257);if(enforceDeviceLimit&&devices.length>=64)throw Error("Device limit reached");if(devices.length>=256)return false;}
 const fingerprint=(value:ChannelObservation)=>JSON.stringify({...value,receivedAt:"",installationId:""});
 const receipt=previous?.receipts?.find((item:any)=>item.id===event.id);
 const older:ChannelObservation|undefined=receipt?.observation||previous?.history?.find((item:ChannelObservation)=>item.id===event.id)||(previous?.current?.id===event.id?previous.current:undefined);
 if(older&&fingerprint(older)!==fingerprint(event))throw Error("Telemetry event ID conflict");
 if(older&&older.receivedAt+"|"+older.installationId<=event.receivedAt+"|"+event.installationId)return false;
 const latest=previous?.current?.id===event.id?event:!previous?.current||order(event)>order(previous.current)?event:previous.current;
 const sessions=new Map<string,ChannelObservation>((previous?.sessions||[]).map((item:ChannelObservation)=>[item.sessionId,item]));const session=sessions.get(event.sessionId);if(!session||session.id===event.id||order(event)>order(session))sessions.set(event.sessionId,event);
 const history=new Map<string,ChannelObservation>((previous?.history||[]).map((item:ChannelObservation)=>[item.id,item]));if(event.reason!=="heartbeat")history.set(event.id,event);
 const receipts=new Map<string,ChannelObservation>((previous?.receipts||[]).map((item:any)=>[item.id,item.observation]));receipts.set(event.id,event);
 await tx.put("device-telemetry",key,{userId:event.userId,deviceId:event.deviceId,firstSeenAt:previous?.firstSeenAt&&previous.firstSeenAt<event.receivedAt?previous.firstSeenAt:event.receivedAt,lastSeenAt:latest.receivedAt,current:latest,sessions:[...sessions.values()].sort((a,b)=>order(b).localeCompare(order(a))).slice(0,8),history:[...history.values()].sort((a,b)=>order(a).localeCompare(order(b))).slice(-128),receipts:[...receipts.values()].sort((a,b)=>order(a).localeCompare(order(b))).slice(-32).map(observation=>({id:observation.id,observation}))});
 return true;
}
export async function queueObservation(tx:any,input:unknown){const observation=parseObservation(input),key=observation.userId+":"+observation.deviceId,old=await tx.get("telemetry-outbox",key);await tx.put("telemetry-outbox",key,{items:[...(old?.items||[]).filter((e:ChannelObservation)=>e.id!==observation.id),observation].slice(-32)});}
export async function acknowledgeObservations(tx:any,observations:ChannelObservation[]){
 const ids=new Set(observations.map(e=>e.id)),keys=new Set(observations.map(e=>e.userId+":"+e.deviceId));
 for(const key of keys){const old=await tx.get("telemetry-outbox",key);if(!old)continue;const items=old.items.filter((e:ChannelObservation)=>!ids.has(e.id));if(items.length)await tx.put("telemetry-outbox",key,{items});else await tx.delete("telemetry-outbox",key);}
}
