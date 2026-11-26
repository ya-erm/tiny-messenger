"use client";

import {useEffect,useState} from "react";
import {createPortal} from "react-dom";

/** SVG elements cannot render the CSS pseudo-elements used by HTML tooltips. */
export function ChartTooltip() {
 const [tip,setTip]=useState<{text:string;x:number;y:number}|null>(null);
 useEffect(()=>{
  let active:Element|null=null;
  const find=(target:EventTarget|null)=>target instanceof Element?target.closest('[data-chart-tooltip]'):null;
  const hide=()=>{active=null;setTip(null);};
  const show=(element:Element,x:number,y:number)=>{active=element;setTip({text:element.getAttribute('data-chart-tooltip')||'',x:Math.max(8,Math.min(x+12,innerWidth-336)),y:Math.max(8,Math.min(y+14,innerHeight-110))});};
  const pointer=(event:PointerEvent)=>{if(event.pointerType!=='mouse')return;const element=find(event.target);if(element)show(element,event.clientX,event.clientY);else if(active)hide();};
  const focus=(event:FocusEvent)=>{const element=find(event.target);if(!element){hide();return;}const bounds=element.getBoundingClientRect();show(element,bounds.left,bounds.bottom);};
  const leave=(event:PointerEvent)=>{if(active&&!active.contains(event.relatedTarget as Node))hide();};
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')hide();};
  document.addEventListener('pointermove',pointer,{passive:true});document.addEventListener('pointerout',leave);document.addEventListener('focusin',focus);document.addEventListener('focusout',hide);document.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('pointermove',pointer);document.removeEventListener('pointerout',leave);document.removeEventListener('focusin',focus);document.removeEventListener('focusout',hide);document.removeEventListener('scroll',hide,true);window.removeEventListener('resize',hide);document.removeEventListener('keydown',key);};
 },[]);
 return tip?createPortal(<div role="tooltip" className="chart-tooltip" style={{left:tip.x,top:tip.y}}>{tip.text}</div>,document.body):null;
}
