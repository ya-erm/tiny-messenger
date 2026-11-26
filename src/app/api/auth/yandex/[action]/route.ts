import {ApiError,ok,readJson,route} from "@/lib/api";
import {authenticate,tokenFromRequest,publicUser} from "@/lib/auth";
import {yandexConfig} from "@/lib/yandex/config";
import {yandexAvailable,makeYandexFlow,exchangeYandexCode} from "@/lib/yandex/protocol";
import {externalStatus,finishYandex} from "@/lib/yandex/service";
import {identityStore} from "@/lib/replication/identity";
import {write} from "@/lib/db";
import {assertRateLimit} from "@/lib/rate-limit";
import {toUserRecord} from "@/lib/store";
type Context={params:Promise<{action:string}>};
export const GET=route<Context>(async(request,{params})=>{
 assertRateLimit(request);const {action}=await params,config=yandexConfig();if(action==="config")return ok({enabled:yandexAvailable(config)});
 if(action!=="link")throw new ApiError(404,"not_found","Не найдено");const user=await authenticate(request);return ok(await write(tx=>externalStatus(identityStore(tx),user.id)));
});
export const POST=route<Context>(async(request,{params})=>{
 assertRateLimit(request);const {action}=await params,body=await readJson(request),config=yandexConfig();
 if(action==="start"){
  if(request.headers.get("Origin")&&request.headers.get("Origin")!==body.origin)throw new ApiError(403,"invalid_origin","Источник входа не совпадает");
  const user=body.mode==="link"?await authenticate(request):undefined;return ok(makeYandexFlow(config,body,user));
 }
 if(action==="exchange")return ok(await exchangeYandexCode(config,body));
 if(action==="finish"){
  const actor=tokenFromRequest(request)?await authenticate(request):undefined;
  const result=await write(async tx=>finishYandex(config,identityStore(tx),body,actor,async operation=>{await identityStore(tx).put("external-pending",operation.id,operation);}));
  return ok("user"in result?{...result,user:publicUser(toUserRecord(result.user))}:result);
 }
 throw new ApiError(404,"not_found","Не найдено");
});
