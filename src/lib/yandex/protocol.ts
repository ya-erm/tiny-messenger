import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {ApiError} from "@/lib/api";
export interface YandexConfig {clientId:string;clientSecret:string;sessionKey:string;origins:string[]}
export const webGeneration=(tokenHash:string)=>createHash("sha256").update(tokenHash).digest("hex");
export const sha256url=(value:string)=>createHash("sha256").update(value).digest("base64url");
const now=()=>Math.floor(Date.now()/1000);
export function yandexAvailable(config:YandexConfig){return !!config.clientId&&!!config.clientSecret&&/^[a-f0-9]{64,}$/.test(config.sessionKey)&&config.origins.length>0;}
function sign(prefix:string,value:unknown,key:string){const data=Buffer.from(JSON.stringify(value)).toString("base64url"),signature=createHmac("sha256",key).update(prefix+data).digest("base64url");return prefix+data+"."+signature;}
function verify(prefix:string,token:unknown,key:string):any{
 if(typeof token!=="string"||!token.startsWith(prefix)||token.length>4096||!/^[a-f0-9]{64,}$/.test(key))throw new ApiError(401,"invalid_token","Недействительное подтверждение входа");
 const parts=token.slice(prefix.length).split(".");if(parts.length!==2)throw new ApiError(401,"invalid_token","Недействительное подтверждение входа");
 const expected=createHmac("sha256",key).update(prefix+parts[0]).digest(),provided=Buffer.from(parts[1],"base64url");
 if(expected.length!==provided.length||!timingSafeEqual(expected,provided))throw new ApiError(401,"invalid_token","Недействительное подтверждение входа");
 let value;try{value=JSON.parse(Buffer.from(parts[0],"base64url").toString());}catch{throw new ApiError(401,"invalid_token","Недействительное подтверждение входа");}
 if(value.v!==1||!Number.isSafeInteger(value.exp)||value.exp<=now())throw new ApiError(401,"invalid_token","Срок подтверждения входа истёк");return value;
}
export function makeWebSession(user:{id:string;tokenHash:string},config:YandexConfig){return sign("tmw_",{v:1,userId:user.id,generation:webGeneration(user.tokenHash),iat:now(),exp:now()+30*86400,id:randomUUID()},config.sessionKey);}
export function webSessionClaims(token:unknown,config:YandexConfig){const value=verify("tmw_",token,config.sessionKey);if(typeof value.userId!=="string"||!/^[a-f0-9]{64}$/.test(value.generation)||!Number.isSafeInteger(value.iat)||value.exp-value.iat>30*86400||value.iat>now()+60)throw new ApiError(401,"invalid_token","Недействительная сессия");return value as {userId:string;generation:string;exp:number};}
export function makeYandexFlow(config:YandexConfig,body:any,user?:{id:string;tokenHash:string}){
 if(!yandexAvailable(config))throw new ApiError(503,"yandex_not_configured","Вход через Яндекс ещё не настроен");
 if(!["login","link"].includes(body.mode)||typeof body.challenge!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge)||!config.origins.includes(body.origin))throw new ApiError(422,"invalid_yandex_flow","Некорректный запрос входа");
 if(body.mode==="link"&&!user)throw new ApiError(401,"missing_token","Сначала войдите в существующий аккаунт");
 const flow={v:1,id:randomUUID(),mode:body.mode,challenge:body.challenge,redirectUri:body.origin+"/auth/yandex/callback/",actorId:user?.id||"",actorGeneration:user?webGeneration(user.tokenHash):"",at:new Date().toISOString(),exp:now()+600};
 const state=sign("tmyf_",flow,config.sessionKey),url=new URL("https://oauth.yandex.ru/authorize");for(const [key,value]of Object.entries({response_type:"code",client_id:config.clientId,redirect_uri:flow.redirectUri,scope:"login:info login:avatar",force_confirm:"yes",state,code_challenge:flow.challenge,code_challenge_method:"S256"}))url.searchParams.set(key,value);
 return {url:url.toString(),state};
}
function verifierMatches(value:any,verifier:unknown){return typeof verifier==="string"&&/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)&&sha256url(verifier)===value.challenge;}
export async function exchangeYandexCode(config:YandexConfig,body:any,fetcher:typeof fetch=fetch){
 if(!yandexAvailable(config))throw new ApiError(503,"yandex_not_configured","Вход через Яндекс ещё не настроен");
 const flow=verify("tmyf_",body.state,config.sessionKey);
 if(!verifierMatches(flow,body.verifier)||typeof body.code!=="string"||body.code.length<4||body.code.length>2048||!config.origins.some(origin=>flow.redirectUri===origin+"/auth/yandex/callback/"))throw new ApiError(400,"invalid_yandex_flow","Подтверждение входа не совпадает с запросом");
 let grant:any,info:any;
 try{
  const response=await fetcher("https://oauth.yandex.ru/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Authorization:"Basic "+Buffer.from(config.clientId+":"+config.clientSecret).toString("base64")},body:new URLSearchParams({grant_type:"authorization_code",code:body.code,code_verifier:body.verifier}),signal:AbortSignal.timeout(6000),redirect:"error"});
  if(!response.ok)throw Error("grant");grant=await response.json();if(typeof grant.access_token!=="string")throw Error("grant");
  const profile=await fetcher("https://login.yandex.ru/info?format=json",{headers:{Authorization:"OAuth "+grant.access_token},signal:AbortSignal.timeout(6000),redirect:"error"});if(!profile.ok)throw Error("profile");info=await profile.json();
 }catch{throw new ApiError(502,"yandex_exchange_failed","Яндекс не подтвердил вход. Начните вход ещё раз.");}
 if(typeof info.psuid!=="string"||info.psuid.length<8||info.psuid.length>256||info.client_id&&String(info.client_id)!==config.clientId)throw new ApiError(502,"yandex_identity_invalid","Не удалось проверить аккаунт Яндекса");
 const subjectHash=createHash("sha256").update("yandex\0"+config.clientId+"\0"+info.psuid).digest("hex"),label=String(info.display_name||info.login||"Яндекс").replace(/[\x00-\x1f\x7f]/g,"").slice(0,80);
 const avatar=info.is_avatar_empty===true?{avatarUrl:null}:info.is_avatar_empty===false&&typeof info.default_avatar_id==="string"&&/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(info.default_avatar_id)&&info.default_avatar_id.length<=400?{avatarUrl:`https://avatars.yandex.net/get-yapic/${info.default_avatar_id}/islands-200`}:{};
 return {proof:sign("tmyv_",{...flow,id:randomUUID(),subjectHash,label,...avatar,exp:Math.min(flow.exp,now()+180)},config.sessionKey)};
}
export function verifiedYandexIdentity(config:YandexConfig,body:any){const value=verify("tmyv_",body.proof,config.sessionKey);if(!verifierMatches(value,body.verifier)||!/^[a-f0-9]{64}$/.test(value.subjectHash)||!["login","link"].includes(value.mode))throw new ApiError(400,"invalid_yandex_flow","Подтверждение входа не совпадает с запросом");return value;}
