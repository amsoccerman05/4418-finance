import type {ReactNode} from 'react';
import {SuiteSwitcher} from './SuiteSwitcher';
import './SuiteHeader.css';
export function SuiteHeader({app,context,account,children}:{app:string;context?:ReactNode;account?:ReactNode;children?:ReactNode}){
 return <header className="suite-header"><a className="suite-brand" href="https://team.frc4418.org/" aria-label="Team Hub / Home"><img src={`${import.meta.env.BASE_URL}branding/4418-impulse-emblem.png`} alt=""/><span>4418 <strong>{app}</strong></span></a><SuiteSwitcher current={app==='Team Hub'?'Team Hub / Home':app}/><div className="suite-context">{context}</div><div className="suite-account">{account}{children}</div></header>;
}
