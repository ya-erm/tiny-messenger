export const STATIC_CLIENT = process.env.NEXT_PUBLIC_STATIC_CLIENT === "1";
export const CHANNEL_KEY = "tiny-messenger:v2:channel";
export const CHANNEL_EVENT = "tiny-messenger:channel";
export const ROUTE_EVENT = "tiny-messenger:route";
export type PhysicalChannel = "default" | "vps-1" | "yandex-1" | "vps-direct";
export type ChannelId = PhysicalChannel | "auto";
export const API_CHANNELS = [
  { id: "default", name: "По умолчанию", alias: "default", origin: "https://api.tm.ya-erm.ru" },
  { id: "vps-1", name: "pro-vm", alias: "pro-vm", origin: "https://ch-1.api.tm.ya-erm.ru" },
  { id: "yandex-1", name: "ya", alias: "ya", origin: "https://ch-2.api.tm.ya-erm.ru" },
  { id: "vps-direct", name: "vm", alias: "vm", origin: "https://ch-3.api.tm.ya-erm.ru" },
] as const;
export const CHANNEL_OPTIONS = [{id:"auto",name:"Авто"},...API_CHANNELS] as const;
export const YANDEX_GATEWAY_ORIGIN = process.env.NEXT_PUBLIC_CLOUD_API_ORIGIN || API_CHANNELS[2].origin;
const TOKEN_KEY="tiny-messenger:v1:token",CACHE_KEY="tiny-messenger:v1:route";
const targets=API_CHANNELS.filter(c=>c.id!=="default");
type Measurement={channel:PhysicalChannel;ok:boolean;latencyMs?:number;installationId?:string;status?:number};
let active:PhysicalChannel|undefined,activeMode:ChannelId|undefined,activeInstallation:string|undefined,gatewayUntil=0,checkedAt=0,checkedCredential="",lastChanged=0,reason="startup",revision=0;
let selecting:Promise<void>|undefined;
const measurements=new Map<PhysicalChannel,Measurement>();
export function selectedMode():ChannelId{
 if(typeof window==="undefined")return "auto";
 try{const saved=localStorage.getItem(CHANNEL_KEY);if(CHANNEL_OPTIONS.some(c=>c.id===saved))return saved as ChannelId;}catch{}
 return "auto";
}
function preferred():PhysicalChannel{
 if(typeof window!=="undefined"&&process.env.NEXT_PUBLIC_VPS_MIRROR_HOST&&window.location.hostname===process.env.NEXT_PUBLIC_VPS_MIRROR_HOST)return "vps-direct";
 return STATIC_CLIENT?"yandex-1":"vps-1";
}
export function selectedChannel():PhysicalChannel{
 const mode=selectedMode();if(mode!=="auto"&&mode!=="default")return mode;
 if(!active){try{const cached=JSON.parse(localStorage.getItem(CACHE_KEY)||"null");if(cached?.mode===mode&&Date.now()-cached.at<86400000&&API_CHANNELS.some(c=>c.id===cached.channel)){active=cached.channel;activeMode=mode;}}catch{}}
 return activeMode===mode&&active?active:mode==="default"?"default":preferred();
}
export function transportStatus(){const channel=selectedChannel(),m=measurements.get(channel);return {mode:selectedMode(),channel,alias:API_CHANNELS.find(c=>c.id===channel)!.alias,installationId:m?.installationId,latencyMs:m?.latencyMs,reason,revision};}
function select(channel:PhysicalChannel,why:string){
 const before=selectedChannel(),mode=selectedMode(),installation=measurements.get(channel)?.installationId;const changed=before!==channel||!!activeInstallation&&!!installation&&activeInstallation!==installation;active=channel;activeMode=mode;activeInstallation=installation;reason=why;
 if(changed){lastChanged=Date.now();revision++;}
 try{localStorage.setItem(CACHE_KEY,JSON.stringify({mode,channel,at:Date.now()}));window.dispatchEvent(new Event(ROUTE_EVENT));if(changed)window.dispatchEvent(new Event(CHANNEL_EVENT));}catch{}
}
export function chooseChannel(id:ChannelId){
 localStorage.setItem(CHANNEL_KEY,id);active=undefined;activeMode=undefined;checkedAt=0;reason="manual";revision++;
 window.dispatchEvent(new Event(CHANNEL_EVENT));window.dispatchEvent(new Event(ROUTE_EVENT));
}
export function channelUrl(path:string,channel:ChannelId=selectedChannel()):string{
 if(!path.startsWith("/api/"))throw Error("Ожидался путь API Messenger");
 if(/^\/api\/(?:rtc|realtime|integrations|push)(?:\/|$)/.test(path))channel=voiceChannel();
 const physical=channel==="auto"?selectedChannel():channel;
 const target=API_CHANNELS.find(c=>c.id===physical)!;
 if(typeof window!=="undefined"&&["localhost","127.0.0.1"].includes(window.location.hostname)&&target.id!=="yandex-1")return path;
 return target.origin+path;
}
function signal(init:RequestInit,ms:number){return init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);}
async function raw(path:string,init:RequestInit,channel:PhysicalChannel,timeout=8000){
 const bounded={...init,signal:signal(init,timeout)},url=channelUrl(path,channel);
 if(channel!=="yandex-1")return fetch(url,bounded);
 if(gatewayUntil>Date.now())return fetch(YANDEX_GATEWAY_ORIGIN+path,bounded);
 try{return await fetch(url,{...bounded,signal:AbortSignal.any([bounded.signal,AbortSignal.timeout(Math.min(1000,timeout))])});}
 catch(error){if(init.signal?.aborted||bounded.signal.aborted)throw error;if(!retrySafe(path,init)){gatewayUntil=Date.now()+300000;throw error;}const response=await fetch(YANDEX_GATEWAY_ORIGIN+path,bounded);gatewayUntil=Date.now()+300000;return response;}
}
function currentCredential(){try{return localStorage.getItem(TOKEN_KEY)||"";}catch{return "";}}
export async function probeChannel(channel:PhysicalChannel,token=currentCredential()):Promise<Measurement>{
 const start=performance.now();
 try{
  const check=async(credential:string)=>raw(credential?"/api/me":"/api/transport",{cache:"no-store",headers:credential?{Authorization:"Bearer "+credential}:{}},channel,6000);
  let response=await check(token);
  if(response.status===401&&token){try{const pending=JSON.parse(localStorage.getItem("tiny-messenger:v1:pending-token-change")||"null");if(pending?.replacementToken)response=await check(pending.replacementToken);}catch{}}
  const body=await response.json();const result={channel,ok:response.ok&&body.ok===true,latencyMs:Math.round(performance.now()-start),installationId:response.headers.get("X-TM-Installation-Id")||body.data?.installationId,status:response.status};
  measurements.set(channel,result);return result;
 }catch{const result={channel,ok:false};measurements.set(channel,result);return result;}
}
async function ensureRoute(force=false,excluded?:PhysicalChannel,credential=currentCredential()){
 if(selecting){await selecting;if(checkedCredential===credential&&!force)return;}
 const mode=selectedMode();if(mode!=="auto"&&mode!=="default")return;
 if(!force&&Date.now()-checkedAt<300000&&activeMode===mode&&checkedCredential===credential)return;
 const run=(async()=>{
  if(mode==="default"&&excluded!=="default"){
   const main=await probeChannel("default",credential);if(selectedMode()!==mode)return;
   if(main.ok){checkedAt=Date.now();checkedCredential=credential;select("default",active&&active!=="default"?"primary-restored":"primary");return;}
  }
  const results:Measurement[]=[];let found!:()=>void;const firstGood=new Promise<void>(resolve=>{found=resolve;});
  const probes=targets.filter(t=>t.id!==excluded).map(t=>probeChannel(t.id,credential).then(result=>{results.push(result);if(result.ok)found();}));
  await Promise.race([Promise.all(probes),firstGood.then(()=>new Promise(resolve=>setTimeout(resolve,250)))]);
  if(selectedMode()!==mode)return;
  const good=results.filter(m=>m.ok).sort((a,b)=>a.latencyMs!-b.latencyMs!);
  if(!good.length){checkedAt=0;throw new TypeError("Нет доступного канала для этой учётной записи");}
  const best=good[0],current=good.find(m=>m.channel===selectedChannel());checkedAt=Date.now();checkedCredential=credential;
  const substantial=!current||best.latencyMs!<current.latencyMs!*.75&&current.latencyMs!-best.latencyMs!>80&&Date.now()-lastChanged>60000;
  if(force||!active||activeMode!==mode||substantial)select(best.channel,force?"unavailable":mode==="default"?"primary-fallback":"latency");
 })();selecting=run;try{await run;}finally{selecting=undefined;}
}
export async function checkChannels(){const result=await Promise.all(API_CHANNELS.map(c=>probeChannel(c.id)));checkedAt=0;await ensureRoute().catch(()=>{});return result;}
function retrySafe(path:string,init:RequestInit){
 if(!init.method||["GET","HEAD","OPTIONS"].includes(init.method))return true;
 if(init.method!=="POST")return false;
 if(["/api/auth/session","/api/sync","/api/changes","/api/messages/poll"].includes(path))return true;
 let body:any;try{body=JSON.parse(String(init.body));}catch{return false;}
 return path==="/api/mutations"&&typeof body.operationId==="string"||path==="/api/auth/register"&&typeof body.clientRequestId==="string"&&typeof body.registrationToken==="string"||path==="/api/me/token"&&typeof body.operationId==="string"&&typeof body.replacementToken==="string"||path==="/api/client/telemetry"&&typeof body.id==="string";
}
function voiceChannel():PhysicalChannel{
 const selected=selectedChannel();if(["vps-1","vps-direct"].includes(selected))return selected;
 const candidates=["vps-1","vps-direct"] as const;return [...candidates].filter(c=>measurements.get(c)?.ok).sort((a,b)=>(measurements.get(a)?.latencyMs||Infinity)-(measurements.get(b)?.latencyMs||Infinity))[0]||"vps-1";
}
export async function fetchChannel(path:string,init:RequestInit={},explicit?:ChannelId):Promise<Response>{
 const pinned=/^\/api\/(?:rtc|realtime|integrations|push)(?:\/|$)/.test(path);
 const automatic=explicit===undefined&&["auto","default"].includes(selectedMode())&&!pinned;
 let credential=new Headers(init.headers).get("Authorization")?.replace(/^Bearer\s+/i,"")||currentCredential();
 if(path==="/api/auth/session")try{credential=JSON.parse(String(init.body)).token||credential;}catch{}
 if(automatic)await ensureRoute(false,undefined,credential);
 const channel=pinned?voiceChannel():explicit&&explicit!=="auto"?explicit:selectedChannel();
 const safe=retrySafe(path,init);
 let response:Response|undefined,failure:unknown;
 try{response=await raw(path,init,channel,safe?8000:25000);if(response.status===401)measurements.set(channel,{channel,ok:false,status:401});if(response.status!==401&&response.status<500||response.status===401&&!automatic)return response;}catch(error){if(init.signal?.aborted)throw error;failure=error;}
 if(!automatic){if(response)return response;throw failure;}
 checkedAt=0;try{await ensureRoute(true,channel,credential);}catch(error){if(response?.status===401&&targets.every(t=>measurements.get(t.id)?.status===401))return response;throw error;}
 await response?.body?.cancel();
 if(safe&&selectedChannel()!==channel)return raw(path,init,selectedChannel(),8000);
 throw new TypeError("Канал изменён. Ответ на запрос не получен; проверьте результат перед повтором.");
}
export function realtimeSocketUrl(){
 if(typeof window!=="undefined"&&["localhost","127.0.0.1"].includes(window.location.hostname))return `${window.location.protocol==="https:"?"wss:":"ws:"}//${window.location.host}/ws`;
 return API_CHANNELS.find(c=>c.id===voiceChannel())!.origin.replace(/^http/,"ws")+"/ws";
}
