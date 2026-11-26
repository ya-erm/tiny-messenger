import assert from 'node:assert/strict';
// Dedicated synthetic accounts only; tests the published client with VPS API blocked.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const dir=fileURLToPath(new URL('../.secrets/yandex-cloud/',import.meta.url));
const [a,b]=JSON.parse(await readFile(dir+'test-users.json','utf8'));
const deployment=JSON.parse(await readFile(dir+'deployment.json','utf8'));
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({serviceWorkers:'block'}),errors=[],mutations=[];
let messageId,uploadId,blocked=0,page;
async function api(origin,path,body,method=body?'POST':'GET'){const r=await fetch(origin+path,{method,headers:{authorization:'Bearer '+a.token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});return {status:r.status,...(await r.json()).data};}
async function onVps(predicate){const start=Date.now();while(Date.now()-start<45000){const result=await api('https://ch-1.api.tm.ya-erm.ru','/api/messages/'+messageId);if(predicate(result))return;await new Promise(r=>setTimeout(r,1000));}throw Error('VPS did not receive rich UI operation');}
try{
 await context.addInitScript(token=>{localStorage.setItem('tiny-messenger:v1:token',token);localStorage.setItem('tiny-messenger:v2:channel','yandex-1');},a.token);
 await context.route(/^https:\/\/(?:api\.tm|ch-1\.api\.tm|ch-2\.api\.tm)\.ya-erm\.ru\//,route=>{blocked++;return route.abort('internetdisconnected');});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async response=>{try{const url=new URL(response.url());if(url.origin!==deployment.gatewayUrl)return;if(url.pathname==='/api/messages'&&response.request().method()==='POST')messageId=(await response.json()).data?.message?.id;if(url.pathname==='/api/mutations'){const operation=JSON.parse(response.request().postData());mutations.push({status:response.status(),type:operation.type,editedSuffix:operation.message?.text?.endsWith(' edited'),errorCode:(await response.json()).error?.code});}if(url.pathname==='/api/attachments/uploads'&&response.request().method()==='POST')uploadId=(await response.json()).data?.attachment?.id;}catch{}});
 await page.goto('https://tm.ya-erm.ru/',{waitUntil:'domcontentloaded'});await page.locator('.contact-row').first().waitFor({timeout:45000});await page.locator('.contact-row').first().click();
 const input=page.getByRole('textbox',{name:'Сообщение',exact:true}),text='UI cloud file '+Date.now();
 await input.fill(text);
 await page.getByLabel('Выбрать файлы',{exact:true}).setInputFiles({name:'cloud-ui-check.txt',mimeType:'text/plain',buffer:Buffer.from('Private queue UI verification\n')});
 await page.waitForFunction(()=>document.querySelector('button[aria-label="Отправить"]')?.disabled===false,null,{timeout:60000});
 await page.getByRole('button',{name:'Отправить',exact:true}).click();
 const item=page.locator('[data-message-id]').filter({hasText:text});await item.waitFor({timeout:45000});messageId=await item.getAttribute('data-message-id');assert.ok(messageId);
 await onVps(r=>r.message?.attachments?.[0]?.id===uploadId);
 await item.hover();await item.getByRole('button',{name:'Реакции и действия'}).click();
 await page.getByRole('menuitem',{name:'Изменить',exact:true}).click();await page.waitForFunction(value=>document.querySelector('textarea[aria-label="Сообщение"]')?.value===value,text);await input.fill(text+' edited');assert.equal(await input.inputValue(),text+' edited');await page.getByRole('button',{name:'Сохранить изменение',exact:true}).click();
 await onVps(r=>r.message?.text===text+' edited');
 const updated=page.locator('[data-message-id="'+messageId+'"]');await updated.hover();await updated.getByRole('button',{name:'Реакции и действия'}).click();await page.locator('.reaction-quick [role="menuitemradio"]').first().click();
 await onVps(r=>r.message?.reactions?.some(x=>x.userId===a.id));
 await updated.hover();await updated.getByRole('button',{name:'Реакции и действия'}).click();await page.getByRole('menuitem',{name:'Удалить',exact:true}).click();await page.getByRole('button',{name:'Удалить у меня и у собеседника',exact:true}).click();
 await onVps(r=>r.status===404);assert.deepEqual(errors,[]);assert.ok(blocked>0);
 for(const type of ['message.edit','reaction.set','message.delete'])assert.ok(mutations.some(m=>m.type===type&&[200,201,202].includes(m.status)),type+' acknowledged');
 const proof={browserFileUploadWithoutVpsApi:true,richCaptionEditThroughClientQueue:true,richReactionThroughClientQueue:true,richDeletionThroughClientQueue:true,deliveredToVps:true,runtimeErrors:0,completedAt:new Date().toISOString()};await writeFile(dir+'rich-queue-browser-proof.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
}catch(error){console.log(JSON.stringify({mutations}));await page?.screenshot({path:'/tmp/tm-rich-queue-failure.png'}).catch(()=>{});throw error;}finally{
 await context.close();await browser.close();
 if(messageId)await api(deployment.gatewayUrl,'/api/messages/'+messageId,{scope:'everyone'},'DELETE').catch(()=>{});
 if(uploadId)await api(deployment.gatewayUrl,'/api/attachments/uploads/'+uploadId,{},'DELETE').catch(()=>{});
}
