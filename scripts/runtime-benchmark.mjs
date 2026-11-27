// Disposable private, read-only runtime comparison. Resource identifiers and
// results are stored only in the ignored private deployment directory.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {serviceAccountCredentials,cloudApi} from './yandex-auth.mjs';
const root=new URL('../',import.meta.url),directory=new URL('.secrets/yandex-cloud/',root),statePath=new URL('runtime-benchmark.json',directory);
const deployment=JSON.parse(await readFile(new URL('deployment.json',directory))),key=JSON.parse(await readFile(new URL('service-account.json',directory))),credentials=serviceAccountCredentials(new URL('service-account.json',directory)),api=cloudApi(credentials);
let state=JSON.parse(await readFile(statePath,'utf8').catch(()=>'null'));
if(!state){const [sample]=JSON.parse(await readFile(new URL('test-users.json',directory)));state={secret:randomBytes(32).toString('hex'),userId:sample.id,functions:{},rounds:[]};}
const save=()=>writeFile(statePath,JSON.stringify(state,null,2),{mode:0o600});
async function complete(op){while(!op.done){await new Promise(resolve=>setTimeout(resolve,2000));op=await api('https://operation.api.cloud.yandex.net/operations/'+op.id);}if(op.error){await writeFile(new URL('runtime-benchmark-operation-error.json',directory),JSON.stringify(op.error),{mode:0o600});throw Error('Cloud operation failed; inspect the private runtime benchmark operation error');}return op.response;}
const functionsApi='https://serverless-functions.api.cloud.yandex.net/functions/v1/';
async function prepare(runtime){
 let entry=state.functions[runtime];
 if(!entry||entry.deletedAt){const created=await complete(await api(functionsApi+'functions',{method:'POST',body:{folderId:deployment.folderId,name:'tm-runtime-benchmark-'+runtime,description:'Disposable private read-only runtime benchmark',labels:{app:'tiny-messenger',purpose:'runtime-benchmark'}}}));state.functions[runtime]=entry={id:created.id};await save();}
 await api(functionsApi+'functions/'+entry.id+':updateAccessBindings',{method:'POST',body:{accessBindingDeltas:[{action:'ADD',accessBinding:{roleId:'serverless.functions.invoker',subject:{id:key.service_account_id,type:'serviceAccount'}}}]}});
 return entry;
}
async function version(runtime){const entry=await prepare(runtime),content=await readFile(new URL('cloud/yandex/dist/benchmark-'+runtime+'.zip',root));
 const sourceHash=createHash('sha256').update(content).digest('hex'),source=entry.versionId&&entry.sourceHash===sourceHash?{versionId:entry.versionId}:{content:content.toString('base64')};
 const created=await complete(await api(functionsApi+'versions',{method:'POST',body:{functionId:entry.id,runtime:runtime==='go'?'golang123':'nodejs22',entrypoint:runtime==='go'?'index.Handler':'index.handler',resources:{memory:'268435456'},executionTimeout:'15s',serviceAccountId:deployment.runtimeServiceAccountId,...source,environment:{YDB_CONNECTION_STRING:deployment.databaseConnectionString,TM_BENCH_USER_ID:state.userId,TM_BENCH_SECRET:state.secret,TM_BENCH_RUN:randomBytes(8).toString('hex')},tag:['benchmark'],concurrency:'1',logOptions:{folderId:deployment.folderId,minLevel:'WARN'}}}));entry.versionId=created.id;entry.sourceHash=sourceHash;await save();
 await complete(await api(functionsApi+'functions/'+entry.id+':setScalingPolicy',{method:'POST',body:{tag:'benchmark',provisionedInstancesCount:'0',zoneInstancesLimit:'1',zoneRequestsLimit:'1'}}));
}
async function call(runtime,mode){const iamToken=await credentials.getToken(),started=performance.now(),entry=state.functions[runtime],response=await fetch('https://functions.yandexcloud.net/'+entry.id+'?tag=benchmark',{method:'POST',headers:{Authorization:'Bearer '+iamToken,'X-TM-Bench-Key':state.secret,'Content-Type':'application/json'},body:JSON.stringify({mode}),signal:AbortSignal.timeout(25000)}),data=await response.json();if(!response.ok)throw Error('Benchmark '+runtime+' returned '+response.status+': '+JSON.stringify(data));return{...data,clientMs:performance.now()-started};}
async function collectWarm(runtime,digest,count=3,initial=[]){
 const known=new Set(initial),observed=[],rows=[];
 for(const round of state.rounds||[]){const item=round.runtimes[runtime];if(item){known.add(item.cold.bootId);for(const row of item.warm)known.add(row.bootId);}}
 for(const burst of state.bursts||[])if(burst.runtime===runtime)for(const row of burst.success)known.add(row.bootId);
 for(const probe of state.probes||[])if(probe.runtime===runtime)for(const row of probe.observed||probe.rows)known.add(row.bootId);
 for(let i=0;i<12&&rows.length<count;i++){const row=await call(runtime,'read');observed.push(row);if(row.digest!==digest)throw Error('Dataset changed during warm probe');if(!row.firstCall&&known.has(row.bootId))rows.push(row);known.add(row.bootId);}
 return{rows,observed};
}
const command=process.argv[2]||'help';
if(command==='help'){console.log('Usage: runtime-benchmark.mjs prepare [node|go] | sample [rounds] | burst node|go [count] | probe | series [waves] [idle-seconds] [warm-count] | cleanup');}
else if(command==='cleanup'){
 for(const entry of Object.values(state.functions)){if(entry.deletedAt)continue;await complete(await api(functionsApi+'functions/'+entry.id,{method:'DELETE'}));entry.deletedAt=new Date().toISOString();await save();}console.log('Disposable benchmark functions removed');
}else if(command==='prepare'){
 for(const runtime of process.argv[3]?[process.argv[3]]:['node','go']){if(!['node','go'].includes(runtime))throw Error('Invalid runtime');await version(runtime);console.log(JSON.stringify({runtime,status:'deployed',memoryMiB:256,provisionedInstances:0}));}
}else if(command==='burst'){
 const runtime=process.argv[3];if(!['node','go'].includes(runtime))throw Error('Invalid runtime');
 const size=Math.max(2,Math.min(6,Number(process.argv[4])||4));await credentials.getToken();
 const settled=await Promise.allSettled(Array.from({length:size},()=>call(runtime,'read'))),success=settled.filter(row=>row.status==='fulfilled').map(row=>row.value),failures=settled.filter(row=>row.status==='rejected').map(row=>({error:String(row.reason).replace(/https?:\/\/\S+/g,'[url]')}));
 const result={at:new Date().toISOString(),runtime,success,failures};state.bursts||=[];state.bursts.push(result);await save();
 console.log(JSON.stringify({runtime,success:success.length,failures:failures.length,cold:success.filter(row=>row.firstCall).map(row=>({clientMs:Math.round(row.clientMs),handlerMs:Math.round(row.handlerMs)})),warm:success.filter(row=>!row.firstCall).map(row=>Math.round(row.clientMs))}));
}else if(command==='probe'){
 await credentials.getToken();state.probes||=[];
 for(const runtime of ['node','go']){const {rows,observed}=await collectWarm(runtime,state.rounds[0].runtimes[runtime].cold.digest);state.probes.push({at:new Date().toISOString(),runtime,rows,observed});await save();if(rows.length!==3)throw Error('Not enough initialized-process calls');console.log(JSON.stringify({runtime,coldMs:observed.filter(row=>row.firstCall).map(row=>Math.round(row.clientMs)),warmMs:rows.map(row=>Math.round(row.clientMs))}));}

}else if(command==='series'){
 const waves=Math.max(1,Math.min(6,Number(process.argv[3])||4)),idleSeconds=Math.max(60,Math.min(180,Number(process.argv[4])||90)),warmCount=Math.max(3,Math.min(8,Number(process.argv[5])||5));
 const series={startedAt:new Date().toISOString(),waves:[],memoryMiB:256,idleSeconds,warmCount,firstCallDefinition:'firstCall=true on a successful read; false flags are never counted as cold'};
 state.series||=[];state.series.push(series);await save();
 for(let wave=0;wave<waves;wave++){
  if(wave)await new Promise(resolve=>setTimeout(resolve,idleSeconds*1000));
  const entry={at:new Date().toISOString(),order:wave%2?['go','node']:['node','go'],runtimes:{}};
  for(const runtime of entry.order){
   const first=await call(runtime,'read');if(!first.userPresent||first.count<1)throw Error('Missing benchmark dataset');
   const {rows:warm,observed}=await collectWarm(runtime,first.digest,warmCount,[first.bootId]);
   if(warm.length!==warmCount)throw Error('Not enough initialized-process calls');
   entry.runtimes[runtime]={first,warm,observed:[first,...observed]};
   console.log(JSON.stringify({wave,runtime,firstMs:Math.round(first.clientMs),firstCall:first.firstCall,coldMs:entry.runtimes[runtime].observed.filter(row=>row.firstCall).map(row=>Math.round(row.clientMs)),warmMs:warm.map(row=>Math.round(row.clientMs))}));
  }
  if(entry.runtimes.node.first.digest!==entry.runtimes.go.first.digest)throw Error('Go/Node datasets disagree');
  series.waves.push(entry);await save();
 }
 const describe=values=>{const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n?{count:n,minMs:Math.round(sorted[0]),medianMs:Math.round(n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2),maxMs:Math.round(sorted[n-1])}:null;};
 const summary={waves:series.waves.length,idleSeconds,memoryMiB:256,runtimes:{}};
 for(const runtime of ['node','go']){
  const entries=series.waves.map(wave=>wave.runtimes[runtime]),cold=[...new Map(entries.flatMap(row=>row.observed.filter(item=>item.firstCall)).map(item=>[item.bootId,item])).values()];
  summary.runtimes[runtime]={cold:describe(cold.map(row=>row.clientMs)),warm:describe(entries.flatMap(row=>row.warm.map(item=>item.clientMs))),messagesRead:entries[0].first.count};
 }
 series.completedAt=new Date().toISOString();series.summary=summary;await save();console.log(JSON.stringify(summary));
}else if(command==='sample'){
 const rounds=Math.max(1,Math.min(10,Number(process.argv[3])||5));
 for(let round=0;round<rounds;round++){
  const result={at:new Date().toISOString(),runtimes:{}};
  for(const runtime of round%2?['go','node']:['node','go']){if(!(round===0&&process.argv[4]==='reuse-first'))await version(runtime);const cold=await call(runtime,'read');if(!cold.firstCall||!cold.userPresent||cold.count<1)throw Error('Missing new process or dataset');const {rows:warm,observed}=await collectWarm(runtime,cold.digest,3,[cold.bootId]);if(warm.length!==3)throw Error('Not enough warm calls');const echo=await call(runtime,'echo');result.runtimes[runtime]={cold,warm,observed,echo};console.log(JSON.stringify({round,runtime,coldMs:Math.round(cold.clientMs),handlerMs:Math.round(cold.handlerMs),warmMs:warm.map(row=>Math.round(row.clientMs))}));}
  if(result.runtimes.node.cold.digest!==result.runtimes.go.cold.digest)throw Error('Go/Node datasets disagree');state.rounds.push(result);await save();
 }
 const summary={rounds:state.rounds.length,memoryMiB:256,readOnly:true,datasetVerified:true,runtimes:{}};
 const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
 for(const runtime of ['node','go']){const rows=state.rounds.map(row=>row.runtimes[runtime]);summary.runtimes[runtime]={coldMedianMs:Math.round(median(rows.map(row=>row.cold.clientMs))),coldMinMs:Math.round(Math.min(...rows.map(row=>row.cold.clientMs))),coldMaxMs:Math.round(Math.max(...rows.map(row=>row.cold.clientMs))),warmMedianMs:Math.round(median(rows.flatMap(row=>row.warm.map(item=>item.clientMs)))),coldHandlerMedianMs:Math.round(median(rows.map(row=>row.cold.handlerMs)))};}
 state.summary=summary;await save();console.log(JSON.stringify(summary));
}else throw Error('Unknown command');
