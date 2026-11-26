"use client";
import {useEffect, useMemo, useState} from "react";
import {fetchChannel, transportStatus} from "@/lib/client-transport";
import {formatFileSize} from "@/lib/attachment-types";
import type {AdminUser} from "@/lib/admin/data";
import type {ChannelObservation} from "@/lib/replication/telemetry-protocol";
type Device = {deviceId:string;firstSeenAt:string;lastSeenAt:string;current:ChannelObservation;sessions:ChannelObservation[];history:ChannelObservation[]};
type Overview = {users:AdminUser[];windowStart:string;today:string;generatedAt:string;truncated:boolean};
async function request<T>(path:string,signal?:AbortSignal):Promise<T> {
 const token=localStorage.getItem("tiny-messenger:v1:token")||"";
 if(!token)throw Error("Войдите в Messenger под аккаунтом администратора.");
 const response=await fetchChannel("/api/admin/"+path,{cache:"no-store",headers:{Authorization:"Bearer "+token},signal});
 const value=await response.json();if(!response.ok||!value.ok)throw Error(value.error?.message||"Не удалось загрузить данные");return value.data;
}
const date=(value:string)=>new Date(value).toLocaleString("ru-RU",{day:"numeric",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit"});
const compact=(value:string|null)=>value?new Date(value).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"Нет данных";
const channel=(value:string)=>({"vps-1":"Канал 1 · pro-vm","yandex-1":"Канал 2 · ya","vps-direct":"Канал 3 · vm",default:"По умолчанию",auto:"Авто"}[value]||value);
const reasons:Record<string,string>={startup:"Запуск",manual:"Выбор вручную",latency:"Меньше задержка",unavailable:"Резервный канал",primary:"Основной канал", "primary-restored":"Основной восстановлен","primary-fallback":"Резерв основного",resume:"Возврат в приложение",heartbeat:"Отчёт"};
function ago(value:string) {
 const seconds=Math.max(0,(Date.now()-Date.parse(value))/1000),relative=new Intl.RelativeTimeFormat("ru-RU",{numeric:"auto"});
 for(const [unit,length] of [["year",31536000],["month",2592000],["day",86400],["hour",3600],["minute",60]] as const)if(seconds>=length)return relative.format(-Math.floor(seconds/length),unit);
 return "только что";
}
function UserAvatar({user,large=false}:{user:AdminUser;large?:boolean}) {
 return <span className={`admin-avatar${large?" large":""}`} style={user.avatarBackground?{backgroundColor:user.avatarBackground}:undefined} aria-hidden="true"><span>{user.name.slice(0,1).toUpperCase()}</span>{user.avatarUrl?<img src={user.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}}/>:null}</span>;
}
function Stat({label,value,note}:{label:string;value:string|number;note?:string}) {
 return <div className="admin-stat"><span>{label}</span><strong>{typeof value==="number"?value.toLocaleString("ru-RU"):value}</strong>{note?<small>{note}</small>:null}</div>;
}
function ActivityChart({points}:{points:Array<{day:string;count:number}>}) {
 const maximum=Math.max(1,...points.map(point=>point.count)),width=1000,height=190,step=width/Math.max(1,points.length);
 const path=points.map((point,index)=>`${index?"L":"M"}${(index+.5)*step},${height-10-(point.count/maximum)*(height-25)}`).join(" ");
 return <div className="admin-chart"><div className="admin-chart-scale"><span>{maximum}</span><span>0</span></div><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Отправленные сообщения по дням: ${points.reduce((sum,point)=>sum+point.count,0)} за период`}>
  <defs><linearGradient id="admin-chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".23"/><stop offset="1" stopColor="currentColor" stopOpacity=".015"/></linearGradient></defs>
  {[.25,.5,.75,1].map(y=><line key={y} x1="0" x2={width} y1={(height-15)*y} y2={(height-15)*y} className="admin-chart-grid"/>)}
  {points.length?<path d={`${path} L${width-step/2},${height} L${step/2},${height} Z`} fill="url(#admin-chart-fill)"/>:null}
  {points.length<=31?points.filter(point=>point.count>0).map(point=><circle key={point.day} cx={(points.indexOf(point)+.5)*step} cy={height-10-(point.count/maximum)*(height-25)} r="3" fill="currentColor"/>):null}
  <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>
  {points.map((point,index)=><rect key={point.day} x={index*step} y="0" width={step} height={height} fill="transparent"><title>{new Date(point.day+"T12:00:00Z").toLocaleDateString("ru-RU")}: {point.count} сообщений</title></rect>)}
 </svg><div className="admin-chart-dates"><span>{points[0] ? new Date(points[0].day+"T12:00:00Z").toLocaleDateString("ru-RU",{day:"numeric",month:"short"}) : ""}</span><span>{points.at(-1) ? new Date(points.at(-1)!.day+"T12:00:00Z").toLocaleDateString("ru-RU",{day:"numeric",month:"short"}) : ""}</span></div></div>;
}
export function AdminPanel() {
 const [overview,setOverview]=useState<Overview>(),[selected,setSelected]=useState("");
 const [devices,setDevices]=useState<Device[]>([]),[error,setError]=useState("");
 const [query,setQuery]=useState(""),[revision,setRevision]=useState(0),[busy,setBusy]=useState(true),[deviceBusy,setDeviceBusy]=useState(false);
 const [source,setSource]=useState(""),[tab,setTab]=useState<"activity"|"devices">("activity");
 const today=new Date().toISOString().slice(0,10),[from,setFrom]=useState(new Date(Date.now()-29*86400000).toISOString().slice(0,10)),[to,setTo]=useState(today);
 useEffect(()=>{
  const controller=new AbortController();setBusy(true);setError("");
  void request<Overview>("users",controller.signal).then(data=>{if(!controller.signal.aborted){setOverview(data);setSource(channel(transportStatus().channel));}}).catch(reason=>{if(!controller.signal.aborted)setError((reason as Error).message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
  return()=>controller.abort();
 },[revision]);
 useEffect(()=>{
  if(!selected)return;const controller=new AbortController();setDeviceBusy(true);setDevices([]);
  void request<{devices:Device[]}>("devices?userId="+encodeURIComponent(selected),controller.signal).then(data=>{if(!controller.signal.aborted)setDevices(data.devices);}).catch(reason=>{if(!controller.signal.aborted)setError((reason as Error).message);}).finally(()=>{if(!controller.signal.aborted)setDeviceBusy(false);});
  return()=>controller.abort();
 },[selected,revision]);
 const users=overview?.users||[],current=users.find(user=>user.id===selected),visible=users.filter(user=>(user.name+" "+(user.nickname||"")+" "+user.id).toLowerCase().includes(query.toLowerCase()));
 const periodDays=Math.floor((Date.parse(to)-Date.parse(from))/86400000)+1,validPeriod=periodDays>0&&periodDays<=366&&from>=(overview?.windowStart||"0000")&&to<=today;
 const points=useMemo(()=>{
  if(!current||!validPeriod)return[];const counts=new Map(current.daily.map(item=>[item.day,item.count]));return Array.from({length:periodDays},(_,index)=>{const day=new Date(Date.parse(from)+index*86400000).toISOString().slice(0,10);return{day,count:counts.get(day)||0};});
 },[current,validPeriod,periodDays,from]);
 const periodTotal=points.reduce((sum,point)=>sum+point.count,0),activeDays=points.filter(point=>point.count>0).length;
 const totalMessages=users.reduce((sum,user)=>sum+user.counters.messages,0),totalFiles=users.reduce((sum,user)=>sum+user.counters.attachments,0);
 function preset(days:number){setFrom(new Date(Date.now()-(days-1)*86400000).toISOString().slice(0,10));setTo(today);}
 return <main className="admin-shell">
  <header className="admin-header"><div><a className="admin-back" href="/">← Tiny Messenger</a><p className="admin-eyebrow">Панель управления</p><h1>Обзор активности</h1><p className="admin-header-note">Пользователи, устройства и связь</p></div><div className="admin-header-actions"><span className="admin-source">{source||"Определяем канал…"}</span><button className="secondary-button" disabled={busy||deviceBusy} onClick={()=>{setError("");setRevision(value=>value+1);}}>{busy?"Загружаем…":"Обновить"}</button></div></header>
  {error?<p className="inline-error" role="alert">{error}</p>:null}
  {overview?.truncated?<p className="inline-error">Достигнут предел выборки. Часть статистики может быть неполной.</p>:null}
  <section className="admin-overview" aria-label="Общая статистика"><Stat label="Аккаунты" value={users.length}/><Stat label="Активны за 7 дней" value={users.filter(user=>user.lastSeenAt&&Date.parse(user.lastSeenAt)>Date.now()-7*86400000).length}/><Stat label="Отправлено сообщений" value={totalMessages}/><Stat label="Вложения в сообщениях" value={totalFiles}/></section>
  <div className="admin-columns"><section className="admin-users"><div className="admin-users-heading"><h2>Пользователи</h2><span>{users.length}</span></div><label className="admin-search"><span className="sr-only">Поиск пользователя</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Имя, ник или UUID"/></label>
   <div className="admin-user-list">{busy&&!overview?<p className="admin-empty">Загружаем пользователей…</p>:!visible.length?<p className="admin-empty">Пользователи не найдены</p>:visible.map(user=><button key={user.id} className={`admin-user ${selected===user.id?"active":""}`} onClick={()=>{setError("");setSelected(user.id);setTab("activity");}}><UserAvatar user={user}/><span className="admin-user-copy"><strong>{user.name}</strong><span>{user.nickname?"@"+user.nickname:user.id.slice(0,8)}</span><time dateTime={user.lastSeenAt||undefined} title={user.lastSeenAt?date(user.lastSeenAt):"Активность ещё не зафиксирована"}>{compact(user.lastSeenAt)}</time></span><span className="admin-user-count" title="Отправлено сообщений">{user.counters.messages}</span></button>)}</div>
  </section><section className="admin-detail">
   {current?<><div className="admin-profile"><UserAvatar user={current} large/><div><h2>{current.name}</h2>{current.nickname?<p className="admin-nickname">@{current.nickname}</p>:null}<code>{current.id}</code></div></div><div className="admin-profile-dates"><p>Создан <strong>{date(current.createdAt)}</strong> <span>({ago(current.createdAt)})</span></p><p>Последняя активность <strong>{compact(current.lastSeenAt)}</strong>{current.lastSeenAt?<span> · {ago(current.lastSeenAt)}</span>:null}</p></div>
    <div className="admin-user-stats"><Stat label="Чаты" value={current.counters.chats}/><Stat label="Отправлено" value={current.counters.messages} note="сообщений"/><Stat label="Вложения" value={current.counters.attachments} note={formatFileSize(current.counters.attachmentBytes)}/></div>
    <div className="admin-tabs" role="tablist" aria-label="Данные пользователя"><button type="button" role="tab" aria-selected={tab==="activity"} aria-controls="admin-activity" id="admin-activity-tab" onClick={()=>setTab("activity")}>Активность</button><button type="button" role="tab" aria-selected={tab==="devices"} aria-controls="admin-devices" id="admin-devices-tab" onClick={()=>setTab("devices")}>Устройства {deviceBusy?"…":devices.length}</button></div>
    {tab==="activity"?<div id="admin-activity" role="tabpanel" aria-labelledby="admin-activity-tab" className="admin-activity-panel"><div className="admin-chart-heading"><div><h3>Сообщения по дням</h3><p>Дневная активность за выбранный период</p></div><div className="admin-presets" aria-label="Период">{[7,30,90].map(days=><button type="button" key={days} className={periodDays===days&&to===today?"active":""} onClick={()=>preset(days)}>{days} дней</button>)}</div></div><div className="admin-period"><label>С<input type="date" value={from} min={overview?.windowStart} max={to} onChange={event=>setFrom(event.target.value)}/></label><label>По<input type="date" value={to} min={from} max={today} onChange={event=>setTo(event.target.value)}/></label><span>UTC</span></div>
     {validPeriod?<><ActivityChart points={points}/><div className="admin-period-stats"><span><strong>{periodTotal}</strong> сообщений</span><span><strong>{activeDays}</strong> активных дней</span><span><strong>{(periodTotal/periodDays).toLocaleString("ru-RU",{maximumFractionDigits:1})}</strong> в среднем за день</span></div>{!periodTotal?<p className="admin-empty">За этот период отправленных сообщений нет.</p>:null}</>:<p className="inline-error">Выберите корректный период в пределах последнего года.</p>}
     <p className="admin-data-note">Счётчики учитывают сохранённую историю, включая доступные записи об удалённых сообщениях. Вложения — файлы, связанные с сообщениями. Последняя активность определяется по отчётам устройств и отправке сообщений; отчёты могут запаздывать примерно на 15 минут.</p>
    </div>:<div id="admin-devices" role="tabpanel" aria-labelledby="admin-devices-tab"><p className="admin-data-note">Один браузер на разных зеркалах учитывается отдельно.</p>{!deviceBusy&&!devices.length?<p className="admin-empty">Устройства ещё не присылали сведения.</p>:null}{devices.map(device=><article className="admin-device" key={device.deviceId}><div className="admin-device-heading"><div><h3>{device.current.platform} · {device.current.browser}</h3><span>{device.current.pwa?"Установленное приложение":"Веб-клиент"} · v{device.current.appVersion}</span></div><span className="admin-device-latency">{device.current.latencyMs===null?"—":device.current.latencyMs+" мс"}</span></div><p className="admin-device-channel">{channel(device.current.channel)} <span>· {channel(device.current.mode)}</span></p><p className="admin-device-meta">{device.current.origin}<br/>Последний отчёт: {compact(device.lastSeenAt)} · {ago(device.lastSeenAt)}</p><code>{device.deviceId}</code><details><summary>История переключений <span>{device.history.length}</span></summary><div className="admin-table-scroll"><table><thead><tr><th>Время</th><th>Канал</th><th>Причина</th><th>Задержка</th></tr></thead><tbody>{[...device.history].reverse().map(event=><tr key={event.id}><td>{compact(event.at)}</td><td>{channel(event.channel)}</td><td>{reasons[event.reason]||event.reason}</td><td>{event.latencyMs===null?"—":event.latencyMs+" мс"}</td></tr>)}</tbody></table></div></details><details><summary>Последние вкладки <span>{device.sessions.length}</span></summary>{device.sessions.map(session=><p key={session.sessionId} className="admin-device-meta"><code>{session.sessionId.slice(0,8)}</code> · {channel(session.channel)} · {compact(session.at)}</p>)}</details></article>)}</div>}
   </>:<div className="admin-empty-selection"><span aria-hidden="true">tm</span><h2>Статистика пользователя</h2><p>Выберите аккаунт слева, чтобы посмотреть активность, устройства и историю каналов.</p></div>}
  </section></div><footer className="admin-footer">Только просмотр · {overview?`Данные обновлены ${compact(overview.generatedAt)}`:"Загружаем данные…"}</footer>
 </main>;
}
