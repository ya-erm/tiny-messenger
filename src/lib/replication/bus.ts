import "server-only";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { read, write } from "@/lib/db";
import { parseMutation } from "@/lib/mutations/protocol";
import { operationFromChange, ingestLocalRows } from "./row-store";
import { applyPeerEvents } from "./apply";
import { createBusTransport } from "../../../scripts/replication-bus/transport.mjs";
import { makeBusFrame, parseBusFrame, BUS_BATCH, busHealth } from "../../../scripts/replication-bus/format.mjs";
let sending: Promise<unknown> | undefined;
async function settings() {
  if (!process.env.TM_REPLICATION_CONFIG) return undefined;
  const config = JSON.parse(await readFile(process.env.TM_REPLICATION_CONFIG,"utf8"));
  return config.bus?.enabled ? config : undefined;
}
export async function receiveBusFrame(input: unknown) {
  const config = await settings();
  if (!config) throw Error("Replication bus disabled");
  const frame = parseBusFrame(input,config.installationId,config.bus.targets.map((target: {installationId:string})=>target.installationId));
  const health = busHealth();
  if (frame.kind === "pong") {
    if (!frame.pending && Date.now()-Date.parse(frame.at)<120000) health.confirmedAt=Date.now();
    return { accepted: true };
  }
  if (frame.kind !== "events") throw Error("Unexpected bus frame");
  await write((tx)=>ingestLocalRows(tx,config.installationId));
  await write((tx)=>applyPeerEvents(tx,frame.from,frame.events,[],config.installationId),{timeout:15000});
  health.receivedAt = Date.now();
  return { accepted: true, operations: frame.events.length };
}
export function publishLocalBus() {
  if (sending) return sending;
  sending=publish().finally(()=>{sending=undefined;});return sending;
}
async function publish() {
  const config=await settings();if(!config)return {enabled:false};
  const stateKey="bus:outgoing", health=busHealth();
  const before=await read(db=>db.replicationState.findUnique({where:{key:stateKey}}));
  let state: {native:number;rows:number;retryAt?:number;failures?:number};
  if(before)state=JSON.parse(before.body);
  else {
    const peer=await read(db=>db.replicationState.findUnique({where:{key:"peer:"+config.peerId}}));
    const snapshot=peer?JSON.parse(peer.body):{};
    state={native:snapshot.sentSeq||0,rows:snapshot.rowSeq||0};
  }
  if((state.retryAt||0)>Date.now())return {enabled:true,retrying:true};
  const [native,rows]=await Promise.all([
    read(db=>db.mutationOperation.findMany({where:{seq:{gt:state.native}},orderBy:{seq:"asc"},take:25})),
    read(db=>db.replicaChange.findMany({where:{seq:{gt:state.rows}},orderBy:{seq:"asc"},take:25})),
  ]);
  if(!native.length&&!rows.length)return{enabled:true,idle:true};
  const events=[...native.filter(item=>!item.originId||item.originId===config.installationId).map(item=>({type:"mutation",operation:parseMutation(JSON.parse(item.body))})),
    ...rows.map(item=>({type:"row",operation:operationFromChange(item,config.installationId)}))];
  try{
    const transport=createBusTransport(config.bus);
    for(const target of config.bus.targets){
      const frames=[];
      for(let index=0;index<events.length;index+=BUS_BATCH)frames.push(makeBusFrame(config.installationId,target.installationId,"events",randomUUID(),{events:events.slice(index,index+BUS_BATCH)}));
      for(let index=0;index<frames.length;index+=10)await transport.publish(target.address,frames.slice(index,index+10));
    }
    state={native:native.at(-1)?.seq||state.native,rows:rows.at(-1)?.seq||state.rows,failures:0};
    await write(tx=>tx.replicationState.upsert({where:{key:stateKey},create:{key:stateKey,body:JSON.stringify(state)},update:{body:JSON.stringify(state)}}));
    return{enabled:true,published:events.length};
  }catch{
    health.failedAt=Date.now();
    const failed={...(before?JSON.parse(before.body):state),failures:(state.failures||0)+1,retryAt:Date.now()+Math.min(60000,2000*2**Math.min(state.failures||0,5))};
    await write(tx=>tx.replicationState.upsert({where:{key:stateKey},create:{key:stateKey,body:JSON.stringify(failed)},update:{body:JSON.stringify(failed)}}));
    console.warn(JSON.stringify({event:"replication-bus",status:"publish_failed"}));
    return{enabled:true,error:"publish_failed"};
  }
}
