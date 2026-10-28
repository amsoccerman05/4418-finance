import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve('.');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(resolve(p,e.name)):[resolve(p,e.name)]);}
export function productionSnapshot(){return Object.fromEntries([...walk(resolve('dist')), ...['package.json','package-lock.json','vite.config.ts','playwright.config.ts'].map(p=>resolve(p))].sort().map(p=>[relative(root,p),hash(p)]));}
export function verifyProduction(){const before=JSON.parse(readFileSync('.playwright-integrity.json','utf8'));if(JSON.stringify(productionSnapshot())!==JSON.stringify(before))throw new Error('Production artifact/config changed during synthetic browser testing');}
if(process.argv[1]===resolve('scripts/role-preview.mjs')){
 if(process.env.HANDOFF_LIVE)throw new Error('Synthetic role fixtures refuse HANDOFF_LIVE');
 writeFileSync('.playwright-integrity.json',JSON.stringify(productionSnapshot(),null,2));
 const result=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir','.playwright-dist'],{stdio:'inherit',env:{...process.env,VITE_SUPABASE_URL:'https://finance-test.supabase.invalid',VITE_SUPABASE_ANON_KEY:'test-public-key'}});
 if(result.status!==0)process.exit(result.status??1);verifyProduction();console.log('Production dist/config unchanged; fixture artifact is separate.');
}
