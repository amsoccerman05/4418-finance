import {useEffect,type ReactNode} from 'react';
import {SuiteSwitcher} from './SuiteSwitcher';
import './SuiteHeader.css';
export function SuiteHeader({app,context,name='Team member',onSignOut,busy=false}:{app:string;context?:ReactNode;name?:string;onSignOut:()=>void;busy?:boolean}){
 useEffect(()=>{document.title=`4418 ${app}`;},[app]);
 return <header className="suite-header"><a className="suite-brand" href="https://team.frc4418.org/" aria-label="Team Hub / Home"><img src={`${import.meta.env.BASE_URL}branding/4418-impulse-emblem.png`} alt=""/><span>4418<strong>{app}</strong></span></a><div className="suite-navigation"><SuiteSwitcher current={app==='Team Hub'?'Team Hub / Home':app}/><div className="suite-context"><span>Workspace</span><span aria-hidden="true">›</span>{context||app}</div></div><div className="suite-account"><span className="suite-name" title={name}>{name}</span><button className="suite-signout" disabled={busy} onClick={onSignOut}>Sign out</button></div></header>;
}
