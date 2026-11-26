import {timelineDevice} from "./timeline";
import {ApiError} from "@/lib/api";
import {validTimeZone,rangeValid,type AdminRange} from "./time";
import {summarizeAdmin,projectAdminRow} from "./data";
// Read-only administration, with an explicit projection of public account fields.
export function adminAllowed(userId: string, allowlist: string) {
  return allowlist.split(",").map(value => value.trim()).filter(Boolean).includes(userId);
}
export async function adminUsers(tx: any,options:{timeZone?:string;range?:AdminRange}={}) {
  const users = await tx.scan("users", 501);
  const records=tx.adminRows?await tx.adminRows():[];
  if(!tx.adminRows){for(const bucket of ["rows:Message","rows:GroupMessage","operations","states","rows:GroupMember","rows:Attachment","device-telemetry","user-state"]){for(const entry of await tx.scanEntries(bucket,20001))records.push(projectAdminRow(bucket,entry.value,entry.key));}}
  return {...summarizeAdmin(users.slice(0,500),records,options),truncated:users.length>500||records.length>=20001};
}
export async function adminDevices(tx: any, userId: unknown) {
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/.test(userId)) throw Error("Invalid admin user ID");
  const rows = await tx.scanPrefix("device-telemetry", userId + ":", 257);
  return {devices: rows.slice(0, 256).map((device: any) => ({deviceId: device.deviceId, firstSeenAt: device.firstSeenAt, lastSeenAt: device.lastSeenAt,
    events:timelineDevice({...device,current:null,history:[],sessions:[]},{from:"1970-01-01T00:00:00.000Z",to:"9999-12-31T23:59:59.999Z"}).events,current: device.current, sessions: device.sessions, history: device.history})), truncated: rows.length > 256};
}

export function adminOptions(params:URLSearchParams){
 try{
  const timeZone=validTimeZone(params.get("timeZone")||"UTC"),from=params.get("from"),to=params.get("to");
  if((from&&!to)||(!from&&to))throw Error("Incomplete range");
  if(!from||!to)return{timeZone};
  if(![from,to].every(value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&new Date(value).toISOString()===value)||!rangeValid({from,to}))throw Error("Invalid range");
  return{timeZone,range:{from,to}};
 }catch{throw new ApiError(422,"invalid_admin_range","Проверьте часовой пояс и интервал (не больше года)");}
}
