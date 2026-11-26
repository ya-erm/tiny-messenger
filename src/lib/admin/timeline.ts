import {ApiError} from "@/lib/api";
import type {AdminRange} from "./time";
export const TIMELINE_CHANNELS=["default","vps-1","yandex-1","vps-direct"] as const;
export type TimelineChannel=typeof TIMELINE_CHANNELS[number];
export interface TimelineEvent{id:string;at:string;receivedAt:string;sessionId:string;channel:TimelineChannel;reason:string;latencyMs:number|null;delayed:boolean}
export interface TimelineDevice{deviceId:string;browser:string;platform:string;origin:string;pwa:boolean;events:TimelineEvent[];truncated?:boolean}
export interface TimelineUser{id:string;devices:TimelineDevice[]}
export interface TimelineData{users:TimelineUser[];truncated:boolean;generatedAt:string}
export function timelineUsers(params:URLSearchParams){const ids=(params.get("users")||"").split(",").filter(Boolean);if(ids.length<1||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>!/^[0-9a-f-]{36}$/.test(id)))throw new ApiError(422,"invalid_timeline_users","Выберите от 1 до 20 пользователей");return ids;}
function eventOf(input:any):TimelineEvent|null{
 if(!input||typeof input.id!=="string"||input.id.length>64||typeof input.sessionId!=="string"||input.sessionId.length>64||!TIMELINE_CHANNELS.includes(input.channel)||!Number.isFinite(Date.parse(input.at))||!Number.isFinite(Date.parse(input.receivedAt)))return null;
 return {id:input.id,at:input.at,receivedAt:input.receivedAt,sessionId:input.sessionId,channel:input.channel,reason:String(input.reason||"").slice(0,64),latencyMs:Number.isInteger(input.latencyMs)?input.latencyMs:null,delayed:Math.abs(Date.parse(input.at)-Date.parse(input.receivedAt))>120000};
}
export function timelineDevice(device:any,range:AdminRange):TimelineDevice{
 const events=new Map<string,TimelineEvent>();
 for(const input of [device.current,...(device.history||[]),...(device.sessions||[]),...(device.receipts||[]).map((item:any)=>item.observation)]){const event=eventOf(input);if(!event)continue;const old=events.get(event.id);if(!old||event.receivedAt<old.receivedAt)events.set(event.id,event);}
 const ordered=[...events.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)),inside=ordered.filter(event=>event.at>=range.from&&event.at<=range.to),context=new Map<string,TimelineEvent>();
 const sessions=new Set(ordered.map(event=>event.sessionId));
 const close=(a:TimelineEvent|undefined,b:TimelineEvent|undefined)=>a&&b&&!a.delayed&&!b.delayed&&Date.parse(b.at)-Date.parse(a.at)<=20*60000;
 for(const sessionId of sessions){const items=ordered.filter(event=>event.sessionId===sessionId),selected=items.filter(event=>event.at>=range.from&&event.at<=range.to),before=items.filter(event=>event.at<range.from).at(-1),after=items.find(event=>event.at>range.to);
  if(close(before,selected[0]||after)&&before)context.set(before.id,before);
  if(close(selected.at(-1)||before,after)&&after)context.set(after.id,after);
 }
 const boundary=[...context.values()],capacity=Math.max(0,128-boundary.length),selected=inside.slice(-capacity),all=[...boundary.slice(-128),...(capacity?selected:[])].sort((a,b)=>a.at.localeCompare(b.at));
 return {deviceId:String(device.deviceId),browser:String(device.current?.browser||"").slice(0,64),platform:String(device.current?.platform||"").slice(0,64),origin:String(device.current?.origin||"").slice(0,200),pwa:!!device.current?.pwa,events:all,truncated:boundary.length+inside.length>128};
}
export async function adminTimeline(tx:any,ids:string[],range:AdminRange):Promise<TimelineData>{
 let truncated=false,remaining=6000,deviceCount=0;const users:TimelineUser[]=[];
 for(const id of ids){
  const rows=await tx.scanPrefix("device-telemetry",id+":",33);if(rows.length>8)truncated=true;
  const devices:TimelineDevice[]=[];
  for(const row of rows.sort((a:any,b:any)=>String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).slice(0,8)){
   if(remaining<=0||deviceCount>=64){truncated=true;break;}
   const device=timelineDevice(row,range);if(device.truncated)truncated=true;if(!device.events.length)continue;
   if(device.events.length>remaining){device.events=device.events.slice(-remaining);truncated=true;}
   remaining-=device.events.length;deviceCount++;devices.push(device);
  }
  users.push({id,devices});
 }
 return{users,truncated,generatedAt:new Date().toISOString()};
}
export function evidenceSegments(events:TimelineEvent[],range:AdminRange){
 const sessions=new Map<string,TimelineEvent[]>();for(const event of events){let items=sessions.get(event.sessionId);if(!items)sessions.set(event.sessionId,items=[]);items.push(event);}
 const result:Array<{from:string;to:string;channel:TimelineChannel;sessionId:string}>=[];
 for(const [sessionId,items]of sessions){items.sort((a,b)=>a.at.localeCompare(b.at));for(let i=1;i<items.length;i++){const a=items[i-1],b=items[i],gap=Date.parse(b.at)-Date.parse(a.at);if(a.delayed||b.delayed||gap<=0||gap>20*60000)continue;const from=a.at<range.from?range.from:a.at,to=b.at>range.to?range.to:b.at;if(from<to)result.push({from,to,channel:a.channel,sessionId});}}
 return result;
}
export function channelDistribution(users:TimelineUser[],range:AdminRange,now=Date.now()){
 const asOf=Math.min(now,Date.parse(range.to)),since=Math.max(Date.parse(range.from),asOf-20*60000);
 const result=TIMELINE_CHANNELS.map(channel=>({channel,users:new Set<string>(),devices:new Set<string>(),sessions:0}));
 for(const user of users)for(const device of user.devices){const latest=new Map<string,TimelineEvent>();for(const event of device.events){const at=Date.parse(event.at);if(!event.delayed&&at>=since&&at<=asOf&&(!latest.has(event.sessionId)||event.at>latest.get(event.sessionId)!.at))latest.set(event.sessionId,event);}for(const event of latest.values()){const item=result.find(item=>item.channel===event.channel)!;item.users.add(user.id);item.devices.add(user.id+":"+device.deviceId);item.sessions++;}}
 return result.map(item=>({channel:item.channel,users:item.users.size,devices:item.devices.size,sessions:item.sessions}));
}
