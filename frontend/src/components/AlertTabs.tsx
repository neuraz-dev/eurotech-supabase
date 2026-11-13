'use client'
import { useRef } from 'react'
export default function AlertTabs({label,value,options,onChange,panelId}:{
  label:string;value:string;options:{value:string;label:string}[];onChange:(value:string)=>void;panelId:string
}){
  const refs=useRef<(HTMLButtonElement|null)[]>([])
  return <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
    {options.map((option,index)=><button key={option.value} ref={node=>{refs.current[index]=node}}
      id={`${panelId}-${option.value}`} role="tab" type="button" aria-selected={option.value===value}
      aria-controls={panelId} tabIndex={option.value===value?0:-1}
      onClick={()=>onChange(option.value)} onKeyDown={event=>{
        let next=index
        if(event.key==='ArrowRight')next=(index+1)%options.length
        else if(event.key==='ArrowLeft')next=(index-1+options.length)%options.length
        else if(event.key==='Home')next=0
        else if(event.key==='End')next=options.length-1
        else return
        event.preventDefault();onChange(options[next].value);refs.current[next]?.focus()
      }} className={`rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-blue-600 ${option.value===value?'bg-white text-blue-800 shadow-sm':'text-slate-600 hover:text-slate-900'}`}>
      {option.label}
    </button>)}
  </div>
}
