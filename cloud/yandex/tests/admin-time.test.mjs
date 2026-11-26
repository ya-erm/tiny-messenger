import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';
import{dayAt,shiftDay,civilInstant,presetRange,axisDays,daysBetween}from'../shared/admin-time.mjs';
import{summarizeAdmin}from'../shared/admin-data.mjs';import{adminOptions}from'../shared/admin-protocol.mjs';import{adminTimeline,evidenceSegments,channelDistribution,timelineUsers}from'../shared/admin-timeline.mjs';import{memoryStore}from'./memory-store.mjs';
test('timezones regroup midnight messages; exact range clips boundary days without changing lifetime counters',()=>{
 const day=shiftDay(dayAt(Date.now(),'UTC'),-2),at=day+'T22:30:00.000Z',users=[{id:'one',name:'One',createdAt:at}],message={bucket:'Message',id:'m',fromUserId:'one',toUserId:'two',at};
 assert.equal(summarizeAdmin(users,[message],{timeZone:'UTC'}).users[0].daily[0].day,day);
 const mskDay=shiftDay(day,1);assert.equal(summarizeAdmin(users,[message],{timeZone:'Europe/Moscow'}).users[0].daily[0].day,mskDay);
 const from=civilInstant(mskDay,'01:00:00','Europe/Moscow'),to=civilInstant(mskDay,'02:00:00','Europe/Moscow',true);
 const result=summarizeAdmin(users,[message,{...message,id:'before',at:new Date(Date.parse(from)-1).toISOString()},{...message,id:'after',at:new Date(Date.parse(to)+1).toISOString()}],{timeZone:'Europe/Moscow',range:{from,to}}).users[0];
 assert.equal(result.counters.messages,3);assert.deepEqual(result.daily,[{day:mskDay,count:1}]);
});
test('civil calendar honours DST gaps, folds and 23/25 hour days',()=>{
 assert.equal(civilInstant('2026-03-29','02:30:00','Europe/Berlin'),null);
 assert.equal(civilInstant('2026-10-25','02:30:00','Europe/Berlin'),'2026-10-25T00:30:00.000Z');
 assert.equal(civilInstant('2026-10-25','02:30:00','Europe/Berlin',true),'2026-10-25T01:30:00.999Z');
 for(const [start,end,hours]of[['2026-03-29','2026-03-30',23],['2026-10-25','2026-10-26',25]])assert.equal((Date.parse(civilInstant(end,'00:00:00','Europe/Berlin'))-Date.parse(civilInstant(start,'00:00:00','Europe/Berlin')))/3600000,hours);
 assert.equal(civilInstant('2026-02-31','12:00:00','UTC'),null);
 const range=presetRange('7d','Europe/Berlin',Date.parse('2026-03-30T10:00:00Z'));assert.equal(daysBetween(dayAt(range.from,'Europe/Berlin'),dayAt(range.to,'Europe/Berlin')).length,7);
});
test('admin query validation and calendar tick density are bounded',()=>{
 for(const query of ['timeZone=invalid','from=2026-01-01T00%3A00%3A00.000Z','from=2026-02-31T00%3A00%3A00.000Z&to=2026-03-05T00%3A00%3A00.000Z','from=2020-01-01T00%3A00%3A00.000Z&to=2026-01-01T00%3A00%3A00.000Z'])assert.throws(()=>adminOptions(new URLSearchParams(query)),e=>e.status===422);
 const days=daysBetween('2026-11-01','2026-11-30'),ticks=axisDays(days,800);assert.equal(ticks.length,5);assert.ok(ticks.every(t=>new Date(t.day+'T12:00:00Z').getUTCDay()===1));
 assert.ok(axisDays(daysBetween('2026-09-01','2026-11-30'),250).length<=4);
 assert.throws(()=>timelineUsers(new URLSearchParams({users:Array.from({length:21},randomUUID).join(',')})),e=>e.status===422);
});
const event=(minute,channel='vps-1',sessionId='session-a',delayed=false)=>({id:randomUUID(),at:new Date(Date.parse('2026-11-26T12:00:00Z')+minute*60000).toISOString(),receivedAt:new Date(Date.parse('2026-11-26T12:00:00Z')+minute*60000).toISOString(),sessionId,channel,reason:'heartbeat',latencyMs:20,delayed});
test('timeline never bridges long gaps, distinct tabs or delayed reports, and never extends the last report',()=>{
 const range={from:'2026-11-26T12:00:00.000Z',to:'2026-11-26T14:00:00.000Z'},events=[event(0),event(5,'yandex-1','another-tab'),event(15),event(45),event(55,'yandex-1','session-a',true),event(65)];
 const spans=evidenceSegments(events,range);assert.equal(spans.length,1);assert.equal(spans[0].from,events[0].at);assert.equal(spans[0].to,events[2].at);assert.ok(spans.every(span=>span.to!==range.to));
});
test('distribution counts users on several concurrent channels without counting a tab twice',()=>{
 const now=Date.parse('2026-11-26T13:00:00Z'),range={from:'2026-11-26T12:00:00.000Z',to:'2026-11-26T14:00:00.000Z'},users=[{id:'one',devices:[{deviceId:'first',events:[event(45),event(50,'vps-direct'),event(55,'yandex-1','second-tab')]}]},{id:'two',devices:[{deviceId:'second',events:[event(48,'yandex-1'),event(10,'default','old-tab')]}]}];
 const result=channelDistribution(users,range,now);assert.equal(result.find(item=>item.channel==='vps-1').users,0);assert.equal(result.find(item=>item.channel==='vps-direct').users,1);assert.equal(result.find(item=>item.channel==='yandex-1').users,2);assert.equal(result.find(item=>item.channel==='default').users,0);
});
test('timeline projection omits unneeded data and preserves report timestamps',async()=>{
 const db=memoryStore(),id=randomUUID(),device=randomUUID(),report={...event(1),userId:id,deviceId:device,platform:'Test',browser:'Test',origin:'https://client.example',pwa:false,token:'must-not-escape',ip:'must-not-escape'};
 await db.transaction(tx=>tx.put('device-telemetry',id+':'+device,{userId:id,deviceId:device,lastSeenAt:report.receivedAt,current:report,history:[report],receipts:[{id:report.id,observation:report}]}));
 const result=await db.transaction(tx=>adminTimeline(tx,[id],{from:'2026-11-26T12:00:00.000Z',to:'2026-11-26T13:00:00.000Z'}));assert.equal(result.users[0].devices[0].events.length,1);assert.ok(!JSON.stringify(result).includes('must-not-escape'));
});
test('timeline keeps clipping context per tab, including a range between reports',async()=>{
 const {timelineDevice}=await import('../shared/admin-timeline.mjs');
 const events=[event(0),event(5,'yandex-1','second-tab'),event(15),event(20,'yandex-1','second-tab')],range={from:'2026-11-26T12:10:00.000Z',to:'2026-11-26T12:12:00.000Z'};
 const device=timelineDevice({deviceId:'device',current:events.at(-1),history:events},range);assert.equal(evidenceSegments(device.events,range).length,2);
 const many=Array.from({length:150},(_,i)=>event(i));assert.equal(timelineDevice({deviceId:'device',current:many.at(-1),history:many},{from:'2026-11-26T12:00:00.000Z',to:'2026-11-26T15:00:00.000Z'}).truncated,true);
});
test('calendar presets handle a timezone whose DST skips midnight',()=>{
 const range=presetRange('30d','America/Santiago',Date.parse('2026-10-05T12:00:00Z'));
 assert.equal(dayAt(range.from,'America/Santiago'),'2026-09-06');assert.equal(range.from,'2026-09-06T04:00:00.000Z');assert.equal(typeof range.to,'string');
});
