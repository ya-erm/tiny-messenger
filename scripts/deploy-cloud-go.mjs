// Default: create an isolated tag. Production is changed only with --promote.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {serviceAccountCredentials,cloudApi} from './yandex-auth.mjs';
const directory=new URL('../.secrets/yandex-cloud/',import.meta.url);
const deployment=JSON.parse(await readFile(new URL('deployment.json',directory),'utf8'));
const progressFile=new URL('go-deployment.json',directory);
let progress=JSON.parse(await readFile(progressFile,'utf8').catch(()=>'{}'));
const credentials=serviceAccountCredentials(new URL('service-account.json',directory)),api=cloudApi(credentials);
const base='https://serverless-functions.api.cloud.yandex.net/functions/v1/';
const save=()=>writeFile(progressFile,JSON.stringify(progress,null,2),{mode:0o600});
async function complete(value){const started=Date.now();while(!value.done){if(Date.now()-started>660000)throw Error('Cloud build still running; inspect the saved operation before retrying');await new Promise(r=>setTimeout(r,3000));value=await api('https://operation.api.cloud.yandex.net/operations/'+value.id);}if(value.error)throw Error(value.error.message);return value.response;}
const mode=process.argv[2]||'--candidate';
if(mode==='--candidate'){
 const current=await api(base+'versions/'+deployment.functionVersionId);
 if(!['nodejs22','golang123'].includes(current.runtime)||!current.tags?.includes('prototype'))throw Error('Saved production version differs from the live tag');
 const content=await readFile(new URL('../cloud/yandex/dist/function-go.zip',import.meta.url));
 progress={nodeVersionId:current.runtime==='nodejs22'?current.id:progress.nodeVersionId,previousVersionId:current.id,functionId:current.functionId,archiveSHA256:createHash('sha256').update(content).digest('hex'),startedAt:new Date().toISOString()};await save();
 const operation=await api(base+'versions',{method:'POST',body:{functionId:current.functionId,runtime:'golang123',entrypoint:'index.Handler',resources:current.resources,executionTimeout:current.executionTimeout,serviceAccountId:current.serviceAccountId,environment:current.environment,content:content.toString('base64'),tag:['go-canary'],concurrency:'1',logOptions:current.logOptions}});
 progress.operationId=operation.id;await save();const version=await complete(operation);progress.goVersionId=version.id;progress.builtAt=new Date().toISOString();await save();
 await complete(await api(base+'functions/'+current.functionId+':setScalingPolicy',{method:'POST',body:{tag:'go-canary',provisionedInstancesCount:'0',zoneInstancesLimit:'1',zoneRequestsLimit:'1'}}));
 console.log(JSON.stringify({status:'candidate-ready',runtime:'golang123',memoryMiB:256,productionChanged:false}));
}else if(mode==='--promote'||mode==='--rollback'){
 const target=mode==='--promote'?progress.goVersionId:(progress.previousVersionId||progress.nodeVersionId);if(!target)throw Error('No saved target version');
 if(mode==='--promote'&&!progress.validatedAt)throw Error('Record completed canary verification before promotion');
 if(mode==='--promote'){
  const check=spawnSync('python3',[new URL('./package-cloud-go.py',import.meta.url).pathname,'--check'],{encoding:'utf8'});
  if(check.status!==0)throw Error('Packaged source no longer matches the verified candidate');
  const content=await readFile(new URL('../cloud/yandex/dist/function-go.zip',import.meta.url));
  if(createHash('sha256').update(content).digest('hex')!==progress.archiveSHA256)throw Error('Archive differs from verified candidate');
  const previous=await api(base+'versions/'+(progress.previousVersionId||progress.nodeVersionId));
  if(!previous.tags?.includes('prototype'))throw Error('Production changed since the candidate was built');
 }

 await complete(await api(base+'versions/'+target+':setTag',{method:'POST',body:{tag:'prototype'}}));
 deployment.functionVersionId=target;await writeFile(new URL('deployment.json',directory),JSON.stringify(deployment,null,2),{mode:0o600});progress[mode==='--promote'?'promotedAt':'rolledBackAt']=new Date().toISOString();await save();console.log(JSON.stringify({status:mode==='--promote'?'promoted':'rolled-back'}));
}else throw Error('Use --candidate, --promote or --rollback');
