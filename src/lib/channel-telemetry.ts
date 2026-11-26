import {fetchChannel,ROUTE_EVENT,transportStatus} from "./client-transport";
const DEVICE="tiny-messenger:v2:device",SESSION="tiny-messenger:v1:telemetry-session";
function identifier(storage:Storage,key:string){let id=storage.getItem(key);if(!id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)){id=crypto.randomUUID();storage.setItem(key,id);}return id;}
export function startChannelTelemetry(userId:string,token:string){
 let stopped=false,sending=false,lastReport=0,lastSignature="";
 const key="tiny-messenger:v1:telemetry-queue:"+userId,deviceId=identifier(localStorage,DEVICE),sessionId=identifier(sessionStorage,SESSION);
 const browser=/Edg\//.test(navigator.userAgent)?"Edge":/Firefox\//.test(navigator.userAgent)?"Firefox":/Chrome\//.test(navigator.userAgent)?"Chrome":/Safari\//.test(navigator.userAgent)?"Safari":"Other";
 const platform=/Android/.test(navigator.userAgent)?"Android":/iPhone|iPad|iPod/.test(navigator.userAgent)?"iOS":/Windows/.test(navigator.userAgent)?"Windows":/Mac/.test(navigator.userAgent)?"macOS":/Linux/.test(navigator.userAgent)?"Linux":"Other";
 const queue=()=>{const items:any[]=[];try{for(let i=0;i<localStorage.length;i++){const name=localStorage.key(i);if(name?.startsWith(key+":")){const item=JSON.parse(localStorage.getItem(name)||"null");if(item?.id)items.push(item);}}}catch{}return items.sort((a,b)=>a.sequence-b.sequence||a.id.localeCompare(b.id));};
 async function flush(){
  if(stopped||sending||!navigator.onLine)return;sending=true;
  try{for(let i=0;i<8&&!stopped;i++){const item=queue()[0];if(!item)break;const response=await fetchChannel("/api/client/telemetry",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(item),signal:AbortSignal.timeout(15000)});if(!response.ok)break;const result=await response.json();if(!result.ok||result.data?.id!==item.id)break;localStorage.removeItem(key+":"+item.id);}}catch{}finally{sending=false;}
 }
 function report(why:string){
  if(stopped||document.visibilityState!=="visible")return;const route=transportStatus(),signature=JSON.stringify([route.mode,route.channel,route.revision]);
  if(why!=="heartbeat"&&lastSignature===signature&&Date.now()-lastReport<900000)return;
  const counterKey=DEVICE+":sequence",previousSequence=Number(localStorage.getItem(counterKey)||"0"),sequence=Number.isSafeInteger(previousSequence)&&previousSequence>=0?previousSequence+1:1;localStorage.setItem(counterKey,String(sequence));
  const observation={id:crypto.randomUUID(),deviceId,sessionId,sequence,at:new Date().toISOString(),mode:route.mode,channel:route.channel,reason:why,latencyMs:route.latencyMs??null,browser,platform,pwa:window.matchMedia("(display-mode: standalone)").matches,appVersion:process.env.NEXT_PUBLIC_APP_VERSION||"",origin:location.origin};
  localStorage.setItem(key+":"+observation.id,JSON.stringify(observation));for(const old of queue().slice(0,-32))localStorage.removeItem(key+":"+old.id);lastReport=Date.now();lastSignature=signature;void flush();
 }
 const routeChanged=()=>report(transportStatus().reason),visible=()=>{if(document.visibilityState==="visible"){if(Date.now()-lastReport>=900000)report("resume");else void flush();}},online=()=>void flush();
 window.addEventListener(ROUTE_EVENT,routeChanged);window.addEventListener("online",online);document.addEventListener("visibilitychange",visible);
 report("startup");const timer=window.setInterval(()=>{if(Date.now()-lastReport>=900000)report("heartbeat");else void flush();},60000);
 return()=>{stopped=true;clearInterval(timer);window.removeEventListener(ROUTE_EVENT,routeChanged);window.removeEventListener("online",online);document.removeEventListener("visibilitychange",visible);};
}
