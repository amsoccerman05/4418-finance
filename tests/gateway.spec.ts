import {test,expect} from '@playwright/test';
for(const width of [390,1440])test(`direct signed-out Finance login stays in place without protected-content flash ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});let flash=false;page.on('console',m=>{if(m.text()==='private-content-flash')flash=true;});await page.addInitScript(()=>new MutationObserver(()=>{if(document.querySelector('.suite-header,.sidebar,.system-card,.page-heading'))console.log('private-content-flash');}).observe(document,{childList:true,subtree:true}));
 await page.route('**/auth/v1/token**',r=>r.fulfill({status:400,json:{error:'invalid_grant',error_description:'Invalid login credentials'}}));
 await page.goto('/#protected');await expect(page.getByRole('heading',{name:'Finance sign in'})).toBeVisible();
 await expect(page).toHaveURL(/\/#protected$/);expect(flash).toBe(false);await expect(page.locator('.suite-header,.sidebar')).toHaveCount(0);
 await page.getByLabel('Email',{exact:true}).fill('finance@example.test');await page.getByLabel('Password',{exact:true}).fill('fixture-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Invalid login credentials');await expect(page).toHaveURL(/\/#protected$/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
