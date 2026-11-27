import {ApiError} from "@/lib/api";
import {applyExternalLink,externalOwners,externalOrder,withExternalProfile,type ExternalLinkOperation} from "../replication/external-protocol";
import {verifiedYandexIdentity,webGeneration,makeWebSession,type YandexConfig} from "./protocol";
export async function externalStatus(tx:any,userId:string){const link=await tx.get("external-users",userId);if(!link||link.deleted)return {linked:false};const owners=await externalOwners(tx,link.subjectHash),profile=withExternalProfile(link,await tx.get("external-profile",userId));return {linked:true,label:link.label,conflict:owners.length>1,linkedAt:link.at,...(Object.hasOwn(profile,"avatarUrl")?{avatarUrl:profile.avatarUrl}:{})};}
async function recordYandexProfile(tx:any,proof:any,userId:string,record?: (operation:ExternalLinkOperation)=>Promise<void>){
 const current=await tx.get("external-users",userId),profile=withExternalProfile(current,await tx.get("external-profile",userId));
 const avatar=Object.hasOwn(proof,"avatarUrl")?{avatarUrl:proof.avatarUrl}:Object.hasOwn(profile||{},"avatarUrl")?{avatarUrl:profile.avatarUrl,avatarVersion:profile.avatarVersion}:{};
 if(current&&!current.deleted&&current.subjectHash===proof.subjectHash&&current.label===proof.label&&(!Object.hasOwn(proof,"avatarUrl")||(profile.avatarUrl??null)===(proof.avatarUrl??null)))return;
 const operation:ExternalLinkOperation={version:1,id:proof.id,userId,provider:"yandex",subjectHash:proof.subjectHash,at:proof.at,deleted:false,label:proof.label,...avatar};
 if(current&&externalOrder(current)>externalOrder(operation))return;
 await applyExternalLink(tx,operation);const saved=await tx.get("external-users",userId);if(saved?.id!==operation.id)throw new ApiError(409,"yandex_link_superseded","Привязка уже была изменена. Начните заново.");
 if(record)await record(operation);
}
export async function finishYandex(config:YandexConfig,tx:any,body:any,actor?:{id:string;tokenHash:string},record?:(operation:ExternalLinkOperation)=>Promise<void>){
 const proof=verifiedYandexIdentity(config,body),owners=await externalOwners(tx,proof.subjectHash);
 if(proof.mode==="login"){
  if(owners.length>1)throw new ApiError(409,"yandex_link_conflict","У Яндекс ID конфликт привязок. Войдите по резервному токену.");
  if(!owners.length)throw new ApiError(404,"yandex_not_linked","Этот Яндекс ID ещё не привязан в данном канале. Сначала привяжите его в настройках существующего аккаунта.");
  const user=await tx.get("users",owners[0]);if(!user)throw new ApiError(409,"yandex_account_pending","Аккаунт ещё синхронизируется");await recordYandexProfile(tx,proof,user.id,record);return {token:makeWebSession(user,config),user};
 }
 if(!actor||actor.id!==proof.actorId||webGeneration(actor.tokenHash)!==proof.actorGeneration)throw new ApiError(403,"yandex_actor_changed","Аккаунт изменился во время привязки. Начните заново.");
 const user=await tx.get("users",actor.id);if(!user||webGeneration(user.tokenHash)!==proof.actorGeneration)throw new ApiError(403,"yandex_actor_changed","Сессия изменилась. Начните привязку заново.");
 if(owners.some(owner=>owner!==actor.id))throw new ApiError(409,"yandex_already_linked","Этот Яндекс ID уже связан с другим аккаунтом Messenger");
 const current=await tx.get("external-users",actor.id);if(current&&!current.deleted&&current.subjectHash!==proof.subjectHash)throw new ApiError(409,"another_yandex_linked","К аккаунту уже привязан другой Яндекс ID");
 if(body.checkOnly)return {canLink:true,userId:actor.id};
 await recordYandexProfile(tx,proof,actor.id,record);return {linked:true,userId:actor.id};
}
