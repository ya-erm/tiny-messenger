import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryStore} from './memory-store.mjs';
import {createService} from '../src/service.mjs';
import {makeYandexFlow,exchangeYandexCode,sha256url,webSessionClaims,makeWebSession} from '../shared/yandex-protocol.mjs';
import {finishYandex,externalStatus} from '../shared/yandex-service.mjs';
import {applyExternalLink} from '../shared/external-protocol.mjs';
const config={clientId:'test-client',clientSecret:'test-secret',sessionKey:'a'.repeat(64),origins:['https://client.example']};
const verifier='a'.repeat(64);
async function fixture(){const db=memoryStore(),service=createService(db,'test',{yandex:config}),registered=await service.registration.register({name:'User'},'192.0.2.1');return{db,service,registered,user:await service.authenticate(registered.token)};}
async function proof(mode,user,psuid='provider-subject-123'){
 const flow=makeYandexFlow(config,{mode,origin:config.origins[0],challenge:sha256url(verifier)},user);
 const calls=[];
 const fetcher=async(url,init)=>{calls.push({url,init});return Response.json(url.includes('/token')?{access_token:'provider-token-must-not-be-stored'}:{psuid,client_id:config.clientId,display_name:'Test Yandex'});};
 const verified=await exchangeYandexCode(config,{state:flow.state,code:'test-code',verifier},fetcher);
 return{...verified,verifier,flow,calls};
}
test('OAuth checks origin, signed state, PKCE and stable provider identity; provider token stays server-side',async()=>{
 const f=await fixture(),p=await proof('link',f.user);
 assert.ok(p.flow.state.length<=1024);
 assert.equal(new URL(p.flow.url).searchParams.get('code_challenge_method'),'S256');
 assert.ok(!JSON.stringify({proof:p.proof}).includes('provider-token-must-not-be-stored'));
 assert.throws(()=>makeYandexFlow(config,{mode:'link',origin:'https://evil.example',challenge:sha256url(verifier)},f.user));
 await assert.rejects(exchangeYandexCode(config,{state:p.flow.state,code:'test-code',verifier:'b'.repeat(64)},()=>{throw Error('must not fetch');}));
 await assert.rejects(exchangeYandexCode(config,{state:p.flow.state+'x',code:'test-code',verifier},()=>{throw Error('must not fetch');}));
 await assert.rejects(f.db.transaction(tx=>finishYandex(config,tx,p,undefined)),e=>e.status===403);
 await f.db.transaction(tx=>finishYandex(config,tx,p,f.user));
 const stored=await f.db.transaction(tx=>tx.get('external-users',f.user.id));
 assert.ok(!JSON.stringify(stored).includes('provider-subject-123'));
 assert.ok(!JSON.stringify(stored).includes('provider-token-must-not-be-stored'));
 assert.equal((await f.db.transaction(tx=>externalStatus(tx,f.user.id))).linked,true);
 await f.db.transaction(tx=>finishYandex(config,tx,p,f.user));
 assert.equal((await f.db.transaction(tx=>tx.scanEntries('external-operations',10))).length,1);
 const other=await f.service.registration.register({name:'Other'},'192.0.2.2'),actor=await f.service.authenticate(other.token),op=await proof('link',actor);
 await assert.rejects(f.db.transaction(tx=>finishYandex(config,tx,op,actor)),e=>e.code==='yandex_already_linked');
});
test('portable sessions work across independent replicas; rotation revokes both and exact retry remains safe',async()=>{
 const a=await fixture(),b=await fixture(),p=await proof('link',a.user);
 await a.db.transaction(tx=>finishYandex(config,tx,p,a.user));
 const external=await a.db.transaction(tx=>tx.get('external-users',a.user.id));
 await b.service.importDirectory({users:[{...a.user,externalIdentity:external}],contacts:[],receipts:[]});
 const login=await proof('login');
 const signed=await b.db.transaction(tx=>finishYandex(config,tx,login));
 assert.equal(signed.user.id,a.user.id);
 assert.equal((await a.service.authenticate(signed.token)).id,a.user.id);
 assert.equal((await b.service.authenticate(signed.token)).id,a.user.id);
 assert.throws(()=>webSessionClaims(signed.token,{...config,sessionKey:'b'.repeat(64)}));
 assert.throws(()=>webSessionClaims(signed.token+'x',config));
 const attempt={operationId:randomUUID(),replacementToken:'msg_'+randomBytes(12).toString('base64url')};
 await b.service.identity.token(signed.token,attempt);
 assert.equal((await b.service.identity.token(signed.token,attempt)).token,attempt.replacementToken);
 await assert.rejects(b.service.authenticate(signed.token));
 const state=await b.db.transaction(tx=>tx.get('identity-state',a.user.id));await a.service.identity.import(state.token);
 await assert.rejects(a.service.authenticate(signed.token));
 const again=await a.db.transaction(tx=>finishYandex(config,tx,login));assert.equal((await a.service.authenticate(again.token)).id,a.user.id);
 await assert.rejects(a.db.transaction(tx=>finishYandex(config,tx,p,a.user)),e=>e.status===403);
});
test('isolated conflicting links converge, block provider login and preserve both native accounts',async()=>{
 const a=await fixture(),b=await fixture();
 await a.service.importDirectory({users:[b.user],contacts:[],receipts:[]});
 await b.service.importDirectory({users:[a.user],contacts:[],receipts:[]});
 const pa=await proof('link',a.user),pb=await proof('link',b.user);
 await a.db.transaction(tx=>finishYandex(config,tx,pa,a.user));await b.db.transaction(tx=>finishYandex(config,tx,pb,b.user));
 const one=await a.db.transaction(tx=>tx.get('external-users',a.user.id)),two=await b.db.transaction(tx=>tx.get('external-users',b.user.id));
 await a.db.transaction(tx=>applyExternalLink(tx,two));await b.db.transaction(tx=>applyExternalLink(tx,one));
 const login=await proof('login');
 for(const f of[a,b]){await assert.rejects(f.db.transaction(tx=>finishYandex(config,tx,login)),e=>e.code==='yandex_link_conflict');assert.equal((await f.service.authenticate(a.registered.token)).id,a.user.id);assert.equal((await f.service.authenticate(b.registered.token)).id,b.user.id);}
 await assert.rejects(a.db.transaction(tx=>applyExternalLink(tx,{...one,label:'Changed'})),/ID conflict/);
});
test('sessions expire and separate provider exchanges never reuse an operation ID',async()=>{
 const f=await fixture(),original=Date.now;
 let expired;
 try{Date.now=()=>original()-31*86400000;expired=makeWebSession(f.user,config);}finally{Date.now=original;}
 assert.throws(()=>webSessionClaims(expired,config),e=>e.status===401);
 const flow=makeYandexFlow(config,{mode:'link',origin:config.origins[0],challenge:sha256url(verifier)},f.user);
 const one=await exchangeYandexCode(config,{state:flow.state,code:'first-code',verifier},async url=>Response.json(url.includes('/token')?{access_token:'temporary'}:{psuid:'first-provider-subject'}));
 const two=await exchangeYandexCode(config,{state:flow.state,code:'second-code',verifier},async url=>Response.json(url.includes('/token')?{access_token:'temporary'}:{psuid:'second-provider-subject'}));
 const decode=proof=>JSON.parse(Buffer.from(proof.slice(5).split('.')[0],'base64url').toString());
 assert.notEqual(decode(one.proof).id,decode(two.proof).id);
});

test('Yandex photo is optional, replicated separately and never changes the Messenger avatar automatically',async()=>{
 const {withExternalProfile}=await import('../shared/external-protocol.mjs');
 const f=await fixture(),other=await fixture();await other.db.transaction(tx=>tx.put('users',f.user.id,f.user));
 const make=async(mode,avatar)=>{
  const flow=makeYandexFlow(config,{mode,origin:config.origins[0],challenge:sha256url(verifier)},mode==='link'?f.user:undefined);
  assert.equal(new URL(flow.url).searchParams.get('scope'),'login:info login:avatar');
  return{...await exchangeYandexCode(config,{state:flow.state,code:'photo-code',verifier},async url=>Response.json(url.includes('/token')?{access_token:'temporary-token'}:{psuid:'photo-subject-123',client_id:config.clientId,display_name:'Фото',...avatar})),verifier};
 };
 const p=await make('link',{is_avatar_empty:false,default_avatar_id:'12345/photo-id'}),events=[];
 await f.db.transaction(tx=>finishYandex(config,tx,p,f.user,async op=>events.push(op)));
 const photo='https://avatars.yandex.net/get-yapic/12345/photo-id/islands-200';
 assert.equal((await f.db.transaction(tx=>externalStatus(tx,f.user.id))).avatarUrl,photo);
 assert.equal((await f.service.authenticate(f.registered.token)).avatarUrl,f.user.avatarUrl);
 const saved=await f.db.transaction(tx=>tx.get('external-operations',events[0].id));assert.equal(Object.keys(saved).length,8);assert.equal(saved.avatarUrl,undefined);
 // A legacy peer may deliver the original eight fields before the supplement.
 await other.db.transaction(tx=>applyExternalLink(tx,saved));
 const directory=await f.db.transaction(async tx=>withExternalProfile(await tx.get('external-users',f.user.id),await tx.get('external-profile',f.user.id)));
 await other.db.transaction(tx=>applyExternalLink(tx,directory));await other.db.transaction(tx=>applyExternalLink(tx,directory));
 assert.equal((await other.db.transaction(tx=>externalStatus(tx,f.user.id))).avatarUrl,photo);
 assert.equal((await other.db.transaction(tx=>tx.get('external-operations',saved.id))).avatarUrl,undefined);
 await assert.rejects(other.db.transaction(tx=>applyExternalLink(tx,{...directory,id:randomUUID(),at:'2099-01-01T00:00:00.000Z',avatarUrl:'https://evil.example/photo'})),/Invalid external avatar/);
 // Login updates provider metadata without replacing a manually chosen picture.
 await new Promise(resolve=>setTimeout(resolve,5));
 const login=await make('login',{is_avatar_empty:false,default_avatar_id:'12345/new-photo'});
 const result=await f.db.transaction(tx=>finishYandex(config,tx,login,undefined,async op=>events.push(op)));
 assert.ok(result.token.startsWith('tmw_'));assert.equal((await f.db.transaction(tx=>externalStatus(tx,f.user.id))).avatarUrl,'https://avatars.yandex.net/get-yapic/12345/new-photo/islands-200');
 await new Promise(resolve=>setTimeout(resolve,5));
 const empty=await make('link',{is_avatar_empty:true,default_avatar_id:'0/0-0'});await f.db.transaction(tx=>finishYandex(config,tx,empty,f.user));
 assert.equal((await f.db.transaction(tx=>externalStatus(tx,f.user.id))).avatarUrl,null);
});
