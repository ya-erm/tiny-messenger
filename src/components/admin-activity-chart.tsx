"use client";
import {useEffect,useId,useMemo,useRef,useState} from "react";
import {axisDays} from "@/lib/admin/time";
export type ChartView="line"|"bars";
function curve(values:Array<{x:number;y:number}>){
 if(!values.length)return'';if(values.length===1)return`M${values[0].x},${values[0].y}`;
 const slopes=values.slice(1).map((point,index)=>(point.y-values[index].y)/(point.x-values[index].x));
 const tangents=values.map((_,index)=>index===0?slopes[0]:index===values.length-1?slopes.at(-1)!:slopes[index-1]*slopes[index]<=0?0:2*slopes[index-1]*slopes[index]/(slopes[index-1]+slopes[index]));
 return values.slice(1).reduce((path,point,index)=>{const before=values[index],dx=(point.x-before.x)/3;return path+` C${before.x+dx},${before.y+dx*tangents[index]} ${point.x-dx},${point.y-dx*tangents[index+1]} ${point.x},${point.y}`;},`M${values[0].x},${values[0].y}`);
}
export function AdminActivityChart({points,view}:{points:Array<{day:string;count:number}>;view:ChartView}) {
 const id=useId().replace(/:/g,''),root=useRef<HTMLDivElement>(null),[pixels,setPixels]=useState(600);
 useEffect(()=>{const element=root.current;if(!element)return;const measure=()=>setPixels(element.clientWidth);measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[]);
 const maximum=Math.max(1,...points.map(point=>point.count)),width=1000,height=190,step=width/Math.max(1,points.length),values=points.map((point,index)=>({x:(index+.5)*step,y:height-10-point.count/maximum*(height-25)})),path=curve(values);
 const ticks=useMemo(()=>axisDays(points.map(point=>point.day),pixels),[points,pixels]);
 return <div className="admin-chart" ref={root}><div className="admin-chart-scale"><span>{maximum}</span><span>0</span></div><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${view==='bars'?'Столбики':'Линия'}: отправленные сообщения по дням, ${points.reduce((sum,point)=>sum+point.count,0)} за период`}>
  <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".24"/><stop offset="1" stopColor="currentColor" stopOpacity=".02"/></linearGradient></defs>
  {[.25,.5,.75,1].map(y=><line key={y} x1="0" x2={width} y1={(height-15)*y} y2={(height-15)*y} className="admin-chart-grid"/>)}
  {view==='line'?<>{points.length?<path d={`${path} L${width-step/2},${height-10} L${step/2},${height-10} Z`} fill={`url(#${id})`}/>:null}<path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/>{points.length<=31?values.map((point,index)=>points[index].count?<circle key={index} cx={point.x} cy={point.y} r="3" fill="currentColor"/>:null):null}</>:points.map((point,index)=>point.count?<rect className="admin-message-bar" key={point.day} x={index*step+step*.15} y={values[index].y} width={step*.7} height={height-10-values[index].y} rx={Math.min(4,step*.12)} fill="currentColor"/>:null)}
  {points.map((point,index)=><rect key={point.day} x={index*step} y="0" width={step} height={height} fill="transparent" tabIndex={0} data-chart-tooltip={`${new Date(point.day+'T12:00:00Z').toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'})}: ${point.count} сообщений`}/>)}
 </svg><div className="admin-chart-dates weekly">{ticks.map(tick=><span key={tick.day} data-monday={new Date(tick.day+'T12:00:00Z').getUTCDay()===1?'true':undefined} style={{left:`${(tick.index+.5)/Math.max(1,points.length)*100}%`,transform:tick.index===0?'none':tick.index===points.length-1?'translateX(-100%)':'translateX(-50%)'}}>{new Date(tick.day+'T12:00:00Z').toLocaleDateString('ru-RU',{day:'numeric',month:'short',timeZone:'UTC'})}<small>{new Date(tick.day+'T12:00:00Z').toLocaleDateString('ru-RU',{weekday:'short',timeZone:'UTC'})}</small></span>)}</div></div>;
}
