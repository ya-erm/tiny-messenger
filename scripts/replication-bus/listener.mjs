import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createBusTransport } from "./transport.mjs";
import { makeBusFrame, busHealth } from "./format.mjs";
export function startBusListener(upstream) {
  if(!process.env.TM_REPLICATION_CONFIG)return()=>{};
  const controller=new AbortController();let timer,stopped=false;
  void(async()=>{
    const config=JSON.parse(await readFile(process.env.TM_REPLICATION_CONFIG,"utf8"));
    if(!config.bus?.enabled)return;
    const transport=createBusTransport(config.bus),health=busHealth();
    const ping=async()=>{try{for(const target of config.bus.targets)await transport.publish(target.address,[makeBusFrame(config.installationId,target.installationId,"ping",randomUUID())]);}catch{health.failedAt=Date.now();}};
    timer=setInterval(()=>void ping(),60000);timer.unref();void ping();
    while(!stopped){
      try{
        const messages=await transport.receive(config.bus.inbox,controller.signal);health.listenerAt=Date.now();
        const accepted=[];
        for(const message of messages){
          const response=await fetch(upstream+"/api/internal/replication/events",{method:"POST",headers:{"content-type":"application/json","x-messenger-internal-token":process.env.MESSENGER_INTERNAL_TOKEN||""},body:message.body,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
          await response.body?.cancel();
          if(response.ok)accepted.push(message);else console.warn(JSON.stringify({event:"bus-delivery",status:response.status}));
        }
        await transport.acknowledge(config.bus.inbox,accepted);
      }catch{
        if(stopped)break;health.failedAt=Date.now();
        await new Promise(resolve=>{const abort=()=>{clearTimeout(id);resolve();};const id=setTimeout(()=>{controller.signal.removeEventListener("abort",abort);resolve();},5000);controller.signal.addEventListener("abort",abort,{once:true});});
      }
    }
  })().catch(()=>console.warn(JSON.stringify({event:"bus-listener",status:"configuration_failed"})));
  return()=>{stopped=true;clearInterval(timer);controller.abort();};
}
