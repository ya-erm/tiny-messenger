import {authenticate} from "@/lib/auth";
import {ok,route,readJson,ApiError} from "@/lib/api";
import {write} from "@/lib/db";
import {identityStore} from "@/lib/replication/identity";
import {parseObservation,storeObservation,queueObservation} from "@/lib/replication/telemetry-protocol";
import {assertRateLimit} from "@/lib/rate-limit";
export const POST=route(async request=>{
 assertRateLimit(request,true);const user=await authenticate(request),body=await readJson(request);let event;
 try{event=parseObservation({...body,userId:user.id,receivedAt:new Date().toISOString(),installationId:process.env.TM_INSTALLATION_ID||"vps-1"});}catch{throw new ApiError(422,"invalid_telemetry","Некорректные данные устройства");}
 await write(async tx=>{const store=identityStore(tx);if(await storeObservation(store,event,true))await queueObservation(store,event);});return ok({accepted:true,id:event.id});
});
