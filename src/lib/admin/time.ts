export type AdminRange = {from:string;to:string;preset?:string};
export type ZoneChoice = "local"|"msk"|"utc";
const formatters=new Map<string,Intl.DateTimeFormat>();
export function validTimeZone(value:unknown="UTC"):string {
 if(typeof value!=="string"||value.length>80)throw new RangeError("Invalid time zone");
 new Intl.DateTimeFormat("en",{timeZone:value});return value;
}
function parts(value:string|number,timeZone:string){
 let formatter=formatters.get(timeZone);if(!formatter){formatter=new Intl.DateTimeFormat("en-GB",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});if(formatters.size>=64)formatters.delete(formatters.keys().next().value!);formatters.set(timeZone,formatter);}
 return Object.fromEntries(formatter.formatToParts(new Date(value)).map(part=>[part.type,part.value]));
}
export function dayAt(value:string|number,timeZone="UTC"){const p=parts(value,timeZone);return `${p.year}-${p.month}-${p.day}`;}
export function timeAt(value:string|number,timeZone="UTC"){const p=parts(value,timeZone);return `${p.hour}:${p.minute}:${p.second}`;}
export function shiftDay(day:string,offset:number){return new Date(Date.parse(day+"T12:00:00Z")+offset*86400000).toISOString().slice(0,10);}
export function daysBetween(from:string,to:string){const count=Math.floor((Date.parse(to)-Date.parse(from))/86400000)+1;return Number.isFinite(count)&&count>=1&&count<=366?Array.from({length:count},(_,index)=>shiftDay(from,index)):[];}
export function civilInstant(day:string,time:string,timeZone:string,end=false):string|null {
 if(!/^\d{4}-\d\d-\d\d$/.test(day)||!/^\d\d:\d\d(:\d\d)?$/.test(time))return null;
 const expected=day+"T"+(time.length===5?time+":00":time),wanted=Date.parse(expected+"Z");if(!Number.isFinite(wanted)||new Date(wanted).toISOString().slice(0,19)!==expected)return null;
 let value=wanted;
 for(let i=0;i<5;i++){const local=Date.parse(dayAt(value,timeZone)+"T"+timeAt(value,timeZone)+"Z"),delta=wanted-local;if(!delta)break;value+=delta;}
 const matches=[-7200000,-3600000,-1800000,0,1800000,3600000,7200000].map(offset=>value+offset).filter(at=>dayAt(at,timeZone)+"T"+timeAt(at,timeZone)===expected);
 if(!matches.length)return null;return new Date((end?Math.max(...matches):Math.min(...matches))+(end?999:0)).toISOString();
}
export function startOfDay(day:string,timeZone:string):number{
 const center=Date.parse(day+"T00:00:00Z");let low=center-36*3600000,high=center+36*3600000;
 while(low<high){const middle=Math.floor((low+high)/2);if(dayAt(middle,timeZone)<day)low=middle+1;else high=middle;}
 return low;
}
export function presetRange(preset:string,timeZone:string,now=Date.now(),minimum?:string):AdminRange {
 const durations:Record<string,number>={"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"3h":10800000,"6h":21600000,"12h":43200000,"24h":86400000,"48h":172800000};
 if(durations[preset])return{from:new Date(now-durations[preset]).toISOString(),to:new Date(now).toISOString(),preset};
 const today=dayAt(now,timeZone),count=Number(preset.replace("d",""))||30;
 const first=preset==="all"?minimum||shiftDay(today,-365):shiftDay(today,-Math.min(365,count-1));
 return{from:new Date(startOfDay(first,timeZone)).toISOString(),to:new Date(startOfDay(shiftDay(today,1),timeZone)-1).toISOString(),preset};
}
export function rangeValid(range:AdminRange){const from=Date.parse(range.from),to=Date.parse(range.to);return Number.isFinite(from)&&Number.isFinite(to)&&from<=to&&to-from<=366*86400000+7200000;}
export function axisDays(days:string[],width:number){
 if(days.length<=8)return days.map((day,index)=>({day,index}));
 const mondays=days.flatMap((day,index)=>new Date(day+"T12:00:00Z").getUTCDay()===1?[{day,index}]:[]),stride=Math.max(1,Math.ceil(mondays.length/Math.max(2,Math.floor(width/65))));
 const ticks=mondays.filter((_,index)=>index%stride===0);if(!ticks.length&&days.length)return[{day:days[0],index:0},{day:days.at(-1)!,index:days.length-1}];return ticks;
}

export function hourlyStarts(range:AdminRange,timeZone:string):string[]{
 const from=Date.parse(range.from),to=Date.parse(range.to);if(!Number.isFinite(from)||!Number.isFinite(to)||to<from||to-from>172800000)return[];
 const time=timeAt(from,timeZone).split(":").map(Number),origin=from-time[1]*60000-time[2]*1000-((from%1000+1000)%1000);
 return Array.from({length:Math.floor((to-origin)/3600000)+1},(_,index)=>new Date(origin+index*3600000).toISOString());
}
