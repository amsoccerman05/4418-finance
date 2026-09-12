import {useEffect,type ReactNode} from 'react';
import './AuthSurface.css';
export const authGateway='https://team.frc4418.org/';
export function AuthSurface({children,redirect=false}:{children?:ReactNode;redirect?:boolean}){
 useEffect(()=>{document.title='4418 IMPULSE';if(redirect)location.replace(authGateway);},[redirect]);
 return <main className="impulse-auth"><section className="impulse-auth-card"><div className="impulse-auth-brand"><img src={`${import.meta.env.BASE_URL}branding/4418-impulse-emblem.png`} alt=""/><strong>4418 IMPULSE</strong></div>{children||<p role="status">{redirect?'Opening team sign in…':'Connecting securely…'}</p>}{redirect&&<a href={authGateway}>Continue to team sign in</a>}</section><footer>FRC Team 4418 · IMPULSE</footer></main>;
}
