import {webSessionClaims,webGeneration} from "@/lib/yandex/protocol";
import {yandexConfig} from "@/lib/yandex/config";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { createToken, hashToken } from "@/lib/auth";
import { write } from "@/lib/db";
import { identityStore, recordIdentity } from "@/lib/replication/identity";
import { assertRateLimit } from "@/lib/rate-limit";
import { randomUUID } from "node:crypto";
export const POST = route(async (request) => {
 assertRateLimit(request,true);
 const body=await readJson(request),stable=body.operationId!==undefined||body.replacementToken!==undefined;
 if(stable&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(body.operationId))||!/^msg_[A-Za-z0-9_-]{16}$/.test(String(body.replacementToken))))throw new ApiError(422,"invalid_token_change","Некорректный запрос замены токена");
 if(body.changedAt!==undefined&&(typeof body.changedAt!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.changedAt)||!Number.isFinite(Date.parse(body.changedAt))))throw new ApiError(422,"invalid_token_change","Некорректное время операции");
 const id=stable?String(body.operationId):randomUUID(),token=stable?String(body.replacementToken):createToken(),tokenHash=hashToken(token);
 const oldToken=(request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"").trim()||request.headers.get("x-api-key")||"";
 if(!oldToken)throw new ApiError(401,"missing_token","Передайте токен Messenger");
 const session=oldToken.startsWith("tmw_")?webSessionClaims(oldToken,yandexConfig()):undefined;
 const callerHash=hashToken(oldToken);
 await write(async tx=>{
  const store=identityStore(tx),receipt=await store.get("identity-operations",id);
  if(receipt){const current=await tx.user.findUnique({where:{id:receipt.userId}});if(receipt.kind!=="token"||(session?(receipt.userId!==session.userId||webGeneration(receipt.previousTokenHash)!==session.generation):receipt.previousTokenHash!==callerHash)||receipt.tokenHash!==tokenHash||current?.tokenHash!==tokenHash||body.changedAt!==undefined&&receipt.at!==body.changedAt)throw new ApiError(409,"token_change_conflict","Замена токена конфликтует с другой операцией");return;}
  const user=await tx.user.findUnique({where:session?{id:session.userId}:{tokenHash:callerHash}});if(!user||session&&webGeneration(user.tokenHash)!==session.generation)throw new ApiError(401,"invalid_token","Токен недействителен");
  const previousTokenHash=user.tokenHash;
  if(await tx.user.findUnique({where:{tokenHash}}))throw new ApiError(409,"token_taken","Такой токен уже используется");
  if(body.changedAt&&Date.parse(String(body.changedAt))>Date.now()+300000)throw new ApiError(422,"invalid_token_change","Проверьте часы устройства");
  await recordIdentity(tx,user.id,{id,kind:"token",tokenHash,previousTokenHash,...(body.changedAt?{at:String(body.changedAt)}:{})});
  if((await tx.user.findUniqueOrThrow({where:{id:user.id}})).tokenHash!==tokenHash)throw new ApiError(409,"token_change_conflict","Уже применена более новая замена токена");
 });
 return ok({token});
});
