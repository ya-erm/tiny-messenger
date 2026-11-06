import "server-only";
import {createHash,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {ApiError} from "@/lib/api";
import {read,write} from "@/lib/db";
import type {UserRecord} from "@/lib/types";
import {signProof,verifyProof,identity} from "./messenger-protocol.mjs";
function integrationSecret() {
 const file = process.env.TASKS_INTEGRATION_SECRET_FILE;
 if (!file) return "";
 try {
  return readFileSync(file, "utf8").trim();
 } catch {
  // An optional integration must not prevent native-token authentication.
  console.warn("Tasks integration disabled: its key file could not be read.");
  return "";
 }
}
const secret=integrationSecret();
function configuredTasksOrigin() {
 try {
  return new URL(process.env.TASKS_ORIGIN || "https://tasks.ya-erm.ru");
 } catch {
  console.warn("Tasks integration disabled: its origin is invalid.");
  return null;
 }
}
const origin=configuredTasksOrigin();
export const tasksOrigin=origin?.origin||"https://tasks.ya-erm.ru";
export const integrationEnabled=Buffer.byteLength(secret)>=32
 && !!origin && (origin.protocol==="https:"||(origin.protocol==="http:"&&process.env.NODE_ENV!=="production"));
function checked(kind:string,value:unknown,maxTTL=300){
 try{if(!integrationEnabled)throw Error();const proof=verifyProof(secret,kind,value,Date.now(),maxTTL);if(kind!=="session"&&proof.origin!==tasksOrigin)throw Error();identity(proof.sub);if(kind!=="connect")identity(proof.tmUserId);if(["login","unlink"].includes(kind))identity(proof.linkId);if(kind==="session"&&(typeof proof.version!=="string"||! /^[a-f0-9]{64}$/.test(proof.version)))throw Error();return proof;}
 catch{throw new ApiError(401,"invalid_token","Подтверждение недействительно или истекло");}
}
export function sessionClaims(token:string){const p=checked("session",token.slice(4),30*24*60*60);identity(p.tmUserId);return p;}
export function connectionPreview(state:unknown){const p=checked("connect",state);return{state,login:typeof p.login==="string"?p.login.slice(0,64):"",name:typeof p.name==="string"?p.name.slice(0,80):"Пользователь задач",origin:tasksOrigin};}
type Link={tasksUserId:string;userId:string;linkId:string};
async function consume(nonce:string,expiresAt:number,run:(tx:Parameters<Parameters<typeof write>[0]>[0])=>Promise<unknown>){
 return write(async tx=>{await tx.$executeRaw`DELETE FROM TasksConsumedProof WHERE expiresAt <= ${Math.floor(Date.now()/1000)}`;const used=await tx.$executeRaw`INSERT OR IGNORE INTO TasksConsumedProof(nonce,expiresAt) VALUES(${nonce},${expiresAt})`;if(used!==1)throw new ApiError(409,"proof_used","Подтверждение уже использовано");return run(tx);});
}
export async function approveConnection(state:unknown,user:UserRecord){
 const p=checked("connect",state),sub=identity(p.sub),linkId=randomUUID();
 await consume(String(p.nonce),Number(p.exp),async tx=>{await tx.$executeRaw`DELETE FROM TasksAccountLink WHERE tasksUserId=${sub} OR userId=${user.id}`;await tx.$executeRaw`INSERT INTO TasksAccountLink(tasksUserId,userId,linkId) VALUES(${sub},${user.id},${linkId})`;});
 return{proof:signProof(secret,"linked",{sub,origin:tasksOrigin,tmUserId:user.id,name:user.name,linkId,challenge:p.nonce},60)};
}
export async function exchangeSession(assertion:unknown){
 const p=checked("login",assertion,30),sub=identity(p.sub),uid=identity(p.tmUserId),linkId=identity(p.linkId);
 const user=await read(db=>db.user.findUnique({where:{id:uid}}));if(!user)throw new ApiError(409,"link_missing","Учётная запись недоступна");
 await consume(String(p.nonce),Number(p.exp),async tx=>{const links=await tx.$queryRaw<Link[]>`SELECT * FROM TasksAccountLink WHERE tasksUserId=${sub} AND userId=${uid} AND linkId=${linkId}`;if(links.length!==1)throw new ApiError(409,"link_missing","Подключите учётную запись заново в настройках задач");});
 // A separate expiring credential; existing device tokens remain valid.
 return{token:"tms_"+signProof(secret,"session",{sub,tmUserId:uid,version:createHash("sha256").update(user.tokenHash).digest("hex")},30*24*60*60),user:{id:user.id,name:user.name,nickname:user.nickname}};
}
export async function unlinkAccount(assertion:unknown){
 const p=checked("unlink",assertion,30),sub=identity(p.sub),uid=identity(p.tmUserId),linkId=identity(p.linkId);
 await consume(String(p.nonce),Number(p.exp),async tx=>{const links=await tx.$queryRaw<Link[]>`SELECT * FROM TasksAccountLink WHERE tasksUserId=${sub}`;if(links.length&&(links[0].userId!==uid||links[0].linkId!==linkId))throw new ApiError(409,"link_changed","Привязка изменилась");await tx.$executeRaw`DELETE FROM TasksAccountLink WHERE tasksUserId=${sub} AND linkId=${linkId}`;});return{unlinked:true};
}
