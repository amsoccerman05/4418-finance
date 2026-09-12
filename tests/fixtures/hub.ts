import {createSuiteClient} from '../../src/suite-auth';
const client=createSuiteClient(import.meta.env.VITE_SUPABASE_URL,import.meta.env.VITE_SUPABASE_ANON_KEY);
client.auth.onAuthStateChange((_e,s)=>{document.querySelector('#state')!.textContent=s?'Shared session ready':'Signed out';});
document.querySelector('#logout')!.addEventListener('click',()=>void client.auth.signOut());

document.querySelector('#login')!.addEventListener('submit',e=>{e.preventDefault();void client.auth.signInWithPassword({email:(document.querySelector('#email') as HTMLInputElement).value,password:(document.querySelector('#password') as HTMLInputElement).value});});
