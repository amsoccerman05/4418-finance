import {test,expect} from '@playwright/test';
for(const width of [390,1440])test(`signed-out gateway has no protected-content flash ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});let flash=false;page.on('console',m=>{if(m.text()==='private-content-flash')flash=true;});await page.addInitScript(()=>new MutationObserver(()=>{if(document.querySelector('.suite-header,.sidebar,.system-card,.page-heading'))console.log('private-content-flash');}).observe(document,{childList:true,subtree:true}));

 await page.route('https://team.frc4418.org/',r=>r.fulfill({contentType:'text/html',body:'<title>4418 IMPULSE</title><h1>Team sign in</h1>'}));await page.goto('/#protected');await expect(page).toHaveURL('https://team.frc4418.org/');expect(flash).toBe(false);await expect(page.locator('.suite-header,.sidebar')).toHaveCount(0);
});
