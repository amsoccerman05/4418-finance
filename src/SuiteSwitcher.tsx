import { useEffect, useRef } from 'react';
import './SuiteSwitcher.css';
import { LayoutGrid, ChevronDown } from 'lucide-react';
const apps = [
 {name:'Team Hub / Home',url:'https://team.frc4418.org/'},
 {name:'Inventory',url:'https://inventory.frc4418.org/'},
 {name:'Pit Operations',url:'https://pit.frc4418.org/'},
 {name:'Finance',url:'https://finance.frc4418.org/'},
 {name:'Attendance',url:'https://team.frc4418.org/#attendance'},
];
export function SuiteSwitcher({current,items=apps}:{current:string;items?:{name:string;url:string|null}[]}) {
 const ref=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{
  const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node)&&ref.current)ref.current.open=false;};
  const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&ref.current?.open){ref.current.open=false;ref.current.querySelector('summary')?.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
 },[]);
 return <details className="suite-picker" ref={ref}><summary aria-label="Team 4418 apps"><LayoutGrid size={16} aria-hidden="true"/><span>{current}</span><ChevronDown className="suite-chevron" size={14} aria-hidden="true"/></summary><nav aria-label="Team 4418 apps"><small>4418 WORKSPACE</small>{items.map(app=><a key={app.url} href={app.url!} aria-current={app.name===current?'page':undefined} onClick={()=>{if(ref.current)ref.current.open=false;}}>{app.name}<span aria-hidden="true">{app.name===current?'●':'↗'}</span></a>)}</nav></details>;
}
