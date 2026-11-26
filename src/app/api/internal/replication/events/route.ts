import { timingSafeEqual } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { receiveBusFrame } from "@/lib/replication/bus";
export const POST=route(async(request)=>{
 const expected=Buffer.from(process.env.MESSENGER_INTERNAL_TOKEN||""),actual=Buffer.from(request.headers.get("x-messenger-internal-token")||"");
 if(!expected.length||expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new ApiError(401,"unauthorized","Недоступно");
 return ok(await receiveBusFrame(await readJson(request,256*1024)));
});
