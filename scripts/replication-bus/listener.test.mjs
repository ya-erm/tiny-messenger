import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {startBusListener} from './listener.mjs';
import {busHealth} from './format.mjs';
test('an idle live listener does not publish minute heartbeats and resumes probes on activity',async()=>{
 const directory=await mkdtemp(tmpdir()+'/tm-idle-listener-'),old={fetch:globalThis.fetch,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,now:Date.now,config:process.env.TM_REPLICATION_CONFIG};
 let now=10_000_000,tick,probes=0,polls=0,stop;
 const health=busHealth();Object.assign(health,{listenerAt:0,confirmedAt:0,failedAt:0,receivedAt:0,activityAt:0,probeAt:0});
 try{
  const file=directory+'/config.json';await writeFile(file,JSON.stringify({installationId:'vps',bus:{enabled:true,provider:'ymq',credentials:{accessKeyId:'TEST',secretAccessKey:'SECRET'},inbox:'https://queue.example/vps',targets:[{installationId:'cloud',address:'https://queue.example/cloud'}]}}));process.env.TM_REPLICATION_CONFIG=file;
  Date.now=()=>now;globalThis.setInterval=callback=>{tick=callback;return{unref(){}};};globalThis.clearInterval=()=>{};
  globalThis.fetch=async(url,init)=>{
   const p=new URLSearchParams(init.body);
   if(p.get('Action')==='SendMessageBatch'){probes++;health.confirmedAt=now+1;return new Response('<Response/>');}
   assert.equal(p.get('Action'),'ReceiveMessage');polls++;
   return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(Error('Stopped')),{once:true});});
  };
  stop=startBusListener('https://local.example');
  for(let i=0;i<100&&!tick;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(probes,1,'One startup check');assert.equal(polls,1,'Incoming long poll remains open');
  for(let minute=1;minute<30;minute++){now=10_000_000+minute*60000;await tick();await new Promise(setImmediate);}
  assert.equal(probes,1,'No extra probes during twenty-nine idle minutes');
  health.activityAt=now;await tick();await new Promise(setImmediate);assert.equal(probes,2,'New activity checks an old peer confirmation promptly');
  console.log(JSON.stringify({startupProbes:1,additionalProbesDuring29IdleMinutes:0,continuousIncomingWait:true,activityRechecksPeer:true}));
 }finally{stop?.();globalThis.fetch=old.fetch;globalThis.setInterval=old.setInterval;globalThis.clearInterval=old.clearInterval;Date.now=old.now;if(old.config===undefined)delete process.env.TM_REPLICATION_CONFIG;else process.env.TM_REPLICATION_CONFIG=old.config;Object.assign(health,{listenerAt:0,confirmedAt:0,failedAt:0,receivedAt:0,activityAt:0,probeAt:0});await rm(directory,{recursive:true,force:true});}
});
