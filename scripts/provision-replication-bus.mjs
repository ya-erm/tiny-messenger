import {readFile,writeFile} from "node:fs/promises";
import {serviceAccountCredentials,cloudApi} from "./yandex-auth.mjs";
import {createYmqTransport,xmlValue} from "./replication-bus/ymq.mjs";
const directory=new URL("../.secrets/yandex-cloud/",import.meta.url);
const deployment=JSON.parse(await readFile(new URL("deployment.json",directory),"utf8"));
const file=new URL("bus.json",directory);
let state=JSON.parse(await readFile(file,"utf8").catch(()=>"{}"));
const api=cloudApi(serviceAccountCredentials(new URL("service-account.json",directory)));
const save=()=>writeFile(file,JSON.stringify(state,null,2),{mode:0o600});
async function complete(value){if(!value.metadata&&!value.response&&!("done"in value))return value;while(!value.done){await new Promise(r=>setTimeout(r,2000));value=await api("https://operation.api.cloud.yandex.net/operations/"+value.id);}if(value.error)throw Error(value.error.message);return value.response;}
if(!state.serviceAccountId){
 const list=await api("https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts?folderId="+deployment.folderId);
 const sa=list.serviceAccounts?.find(sa=>sa.name==="tm-replication-bus")||await complete(await api("https://iam.api.cloud.yandex.net/iam/v1/serviceAccounts",{method:"POST",body:{folderId:deployment.folderId,name:"tm-replication-bus",description:"Private Tiny Messenger event transport"}}));
 state.serviceAccountId=sa.id;await save();
}
await complete(await api(`https://resource-manager.api.cloud.yandex.net/resource-manager/v1/folders/${deployment.folderId}:updateAccessBindings`,{method:"POST",body:{accessBindingDeltas:[
 ...["ymq.writer","ymq.reader"].map(roleId=>({action:"ADD",accessBinding:{roleId,subject:{id:state.serviceAccountId,type:"serviceAccount"}}})),
 {action:"ADD",accessBinding:{roleId:"ymq.reader",subject:{id:deployment.runtimeServiceAccountId,type:"serviceAccount"}}},
]}}));
if(!state.credentials){const key=await api("https://iam.api.cloud.yandex.net/iam/aws-compatibility/v1/accessKeys",{method:"POST",body:{serviceAccountId:state.serviceAccountId,description:"Private replication bus, not user API"}});state.credentials={accessKeyId:key.accessKey.keyId,secretAccessKey:key.secret};await save();}
state.provider="ymq";state.enabled=true;state.endpoint="https://message-queue.api.cloud.yandex.net";state.region="ru-central1";
const transport=createYmqTransport(state);
state.queues||={};
for(const id of ["vps-1","yandex-1"]){
 if(state.queues[id])continue;
 const queueName="tm-events-"+id;
 let response;
 for(let attempt=0;attempt<8;attempt++){try{response=await transport.request("CreateQueue",{QueueName:queueName,"Attribute.1.Name":"ReceiveMessageWaitTimeSeconds","Attribute.1.Value":"20","Attribute.2.Name":"MessageRetentionPeriod","Attribute.2.Value":"345600","Attribute.3.Name":"VisibilityTimeout","Attribute.3.Value":"60"});break;}catch(error){if(attempt===7)throw error;await new Promise(r=>setTimeout(r,3000));}}
 const url=xmlValue(response,"QueueUrl");if(!url)throw Error("Queue URL missing");
 let attributes;
 for(let attempt=0;attempt<8;attempt++){try{attributes=await transport.request("GetQueueAttributes",{QueueUrl:url,"AttributeName.1":"QueueArn"});break;}catch(error){if(attempt===7)throw error;await new Promise(r=>setTimeout(r,3000));}}
 const arn=xmlValue(attributes,"Value");if(!arn)throw Error("Queue ARN missing");
 state.queues[id]={url,arn};await save();
}
await save();
// The trigger is enabled only after publishing the new compatible function.
if(process.argv.includes("--trigger")){
 const endpoint="https://serverless-triggers.api.cloud.yandex.net/triggers/v1/triggers";
 const list=await api(endpoint+"?folderId="+deployment.folderId);
 const trigger=list.triggers?.find(t=>t.name==="tm-replication-inbox")||await complete(await api(endpoint,{method:"POST",body:{folderId:deployment.folderId,name:"tm-replication-inbox",description:"Private replication event consumer",rule:{messageQueue:{queueId:state.queues["yandex-1"].arn,serviceAccountId:deployment.runtimeServiceAccountId,batchSettings:{size:"1",cutoff:"1s"},visibilityTimeout:"60s",invokeFunction:{functionId:deployment.functionId,functionTag:"prototype",serviceAccountId:deployment.runtimeServiceAccountId}}}}}));
 state.triggerId=trigger.id;await save();
}
console.log(JSON.stringify({serviceAccountId:state.serviceAccountId,queues:Object.keys(state.queues),triggerId:state.triggerId||null}));
