import assert from 'node:assert/strict';
import{readFile}from'node:fs/promises';import{createRequire}from'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'playwright');
const env=Object.fromEntries((await readFile(new URL('../deploy/release.env',import.meta.url),'utf8')).trim().split('\n').map(line=>line.split('='))),ts=require(env.MESSENGER_DEPENDENCIES_DIR+'/typescript');
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const cache=compile(await readFile(new URL('../src/lib/image-cache.ts',import.meta.url),'utf8'));
const thumbnail=compile(await readFile(new URL('../src/lib/image-thumbnail.ts',import.meta.url),'utf8')).replace('"./webp-worker-client"','"/codec.mjs"');
const codec=compile(await readFile(new URL('../src/lib/webp-worker-client.ts',import.meta.url),'utf8'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=','base64');
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const context=await browser.newContext({serviceWorkers:'block'});let apiCalls=0,downloads=0;
 await context.route('https://client.example/**',route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('.mjs'))return route.fulfill({contentType:'text/javascript',body:url.pathname==='/cache.mjs'?(url.searchParams.has('small')?cache.replace('100 * 1024 * 1024','500'):cache):url.pathname==='/thumbnail.mjs'?thumbnail:codec});
  if(url.pathname.startsWith('/api/')){apiCalls++;return route.fulfill({contentType:'application/json',body:JSON.stringify({url:'https://client.example/media/'+apiCalls,expiresAt:new Date(Date.now()+1000).toISOString()})});}
  if(url.pathname.startsWith('/media/')){downloads++;return route.fulfill({contentType:'image/png',body:png,headers:{'Cache-Control':'no-store'}});}
  return route.fulfill({contentType:'text/html',body:'<title>Image cache checks</title>'});
 });
 const page=await context.newPage();
 async function setup(module='/cache.mjs',target=page){
  await target.goto('https://client.example/');await target.evaluate(async module=>{
   window.cache=await import(module);window.cache.enableImageCache('user-a');window.cache.enableImageCache('user-b');
   window.load=(user='user-a',id='file-a',hasThumbnail=false,small=false)=>window.cache.imageSource(user,{id,originalName:'pixel.png',size:68,contentType:'image/png',preview:'image',hasThumbnail},async path=>{const r=await fetch(path);return r.json();},small);
  },module);
 }
 await setup();await page.evaluate(async()=>{const images=await Promise.all([window.load(),window.load()]);const first=new Image();first.src=images[0].url;await first.decode();images[0].release();const second=new Image();second.src=images[1].url;await second.decode();images[1].release();});
 assert.equal(apiCalls,1);assert.equal(downloads,1);
 await setup();await page.evaluate(async()=>{const image=await window.load();image.release();});assert.equal(apiCalls,1,'reload retains cached bytes independent of signed URL lifetime');
 await page.evaluate(async()=>{const image=await window.load('user-b');image.release();});assert.equal(apiCalls,2,'other account cannot reuse private media');
 await page.evaluate(async()=>{for(const small of[true,false,true,false]){const image=await window.load('user-a','with-thumbnail',true,small);image.release();}});assert.equal(apiCalls,4,'thumbnail and full image have separate reusable entries');
 await page.evaluate(async()=>{await window.cache.clearImageCache('user-a');window.cache.enableImageCache('user-a');const image=await window.load();image.release();});assert.equal(apiCalls,5,'logout removes cached media');
 await page.evaluate(async()=>{const original=Date.now;try{Date.now=()=>original()+15*86400000;const image=await window.load();image.release();}finally{Date.now=original;}});assert.equal(apiCalls,6,'expired entry fetches a fresh image');
 const writer=await context.newPage();await setup('/cache.mjs',writer);const raceBaseline=apiCalls;
 await writer.evaluate(()=>{window.nativeFetch=fetch;window.hold=new Promise(resolve=>window.releaseHold=resolve);window.fetch=async(url,init)=>{if(String(url).includes('/media/')){window.holdSeen=true;await window.hold;}return window.nativeFetch(url,init);};window.inFlight=window.load('user-a','logout-race');});
 await writer.waitForFunction(()=>window.holdSeen);await page.evaluate(()=>window.cache.clearImageCache('user-a'));
 await writer.evaluate(async()=>{window.releaseHold();const result=await window.inFlight;result.release();window.fetch=window.nativeFetch;window.cache.enableImageCache('user-a');const fresh=await window.load('user-a','logout-race');fresh.release();});assert.equal(apiCalls-raceBaseline,2,'another tab cannot repopulate the cache using an old epoch after logout');await writer.close();
 await page.evaluate(async()=>{await window.cache.clearImageCache('user-a');await window.cache.clearImageCache('user-b');});
 await setup('/cache.mjs?small');const before=apiCalls;await page.evaluate(async()=>{for(let index=0;index<15;index++){const image=await window.load('user-a','bounded-'+index);image.release();}const recent=await window.load('user-a','bounded-14');recent.release();const old=await window.load('user-a','bounded-0');old.release();});assert.equal(apiCalls-before,16,'bounded cache evicts old bytes and keeps a recent image');
 const generated=await page.evaluate(async()=>{
  const {imageThumbnail}=await import('/thumbnail.mjs'),canvas=document.createElement('canvas');canvas.width=1400;canvas.height=1000;const context=canvas.getContext('2d'),pixels=context.createImageData(canvas.width,canvas.height);let value=17;for(let i=0;i<pixels.data.length;i+=4){value=(value*1664525+1013904223)>>>0;pixels.data[i]=value&255;pixels.data[i+1]=(value>>>8)&255;pixels.data[i+2]=(value>>>16)&255;pixels.data[i+3]=255;}context.putImageData(pixels,0,0);
  const original=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),small=await imageThumbnail(new File([original],'photo.png',{type:'image/png'}));if(!small)throw Error('Expected small derivative');const image=await createImageBitmap(small);const result={bytes:small.size,originalBytes:original.size,width:image.width,height:image.height,type:small.type};image.close();return result;
 });assert.ok(generated.bytes<=102400&&generated.bytes<generated.originalBytes*.8&&generated.width<=640&&generated.height<=640);assert.equal(generated.type,'image/webp');
 console.log(JSON.stringify({persistentImageCache:true,concurrentFetchDeduplicated:true,separateAccounts:true,thumbnailAndFullReused:true,logoutPurges:true,crossTabLogoutRaceBlocked:true,expiryRefreshes:true,boundedEviction:true,smallWebpGenerated:true}));await context.close();
}finally{await browser.close();}
