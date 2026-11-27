// Load the production Node dependency graph, including its SDK imports.
import '../../src/handler.mjs';
import {connectYdb} from '../../src/store-ydb.mjs';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
const bootId=randomUUID();let calls=0,databasePromise;
const response=(status,data)=>({statusCode:status,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify(data)});
export async function handler(event){
 const started=performance.now(),firstCall=++calls===1;
 const supplied=Object.entries(event.headers||{}).find(([name])=>name.toLowerCase()==='x-tm-bench-key')?.[1]||'',expected=process.env.TM_BENCH_SECRET||'';
 if(!expected||supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return response(403,{error:'forbidden'});
 try{
  const body=JSON.parse(event.body||'{}');if(!['echo','read'].includes(body.mode))return response(422,{error:'invalid_mode'});
  let connectMs=0,readMs=0,count=0,userPresent=false,digest=null;
  if(body.mode==='read'){
   const userId=process.env.TM_BENCH_USER_ID;if(!/^[0-9a-f-]{36}$/.test(userId||''))throw Error('invalid_dataset');
   const connectStart=performance.now();databasePromise||=connectYdb(process.env.YDB_CONNECTION_STRING).catch(error=>{databasePromise=undefined;throw error;});const database=await databasePromise;connectMs=performance.now()-connectStart;
   const readStart=performance.now(),data=await database.transaction(async tx=>({user:await tx.get('users',userId),messages:await tx.views(userId,100)}),{readOnly:true});readMs=performance.now()-readStart;
   count=data.messages.length;userPresent=!!data.user;digest=createHash('sha256').update([data.user?.id||'',...data.messages.map(message=>message.id)].sort().join('\n')).digest('hex');
  }
  return response(200,{runtime:'node',bootId,firstCall,mode:body.mode,userPresent,count,digest,connectMs,readMs,handlerMs:performance.now()-started});
 }catch{return response(503,{error:'benchmark_read_failed',runtime:'node',bootId,firstCall,handlerMs:performance.now()-started});}
}
