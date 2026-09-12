import {test,expect} from '@playwright/test';
for(const width of [390,1440])test(`suite switcher keyboard and mobile layout ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.addInitScript(()=>localStorage.setItem('4418-finance-auth',JSON.stringify({access_token:'fixture-token',refresh_token:'fixture-refresh',expires_at:4000000000,token_type:'bearer',user:{id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',app_metadata:{},user_metadata:{}}})));await page.route('**/rest/v1/**',r=>r.fulfill({status:403,json:{code:'42501',message:'Access denied'}}));await page.goto('/');
 await page.locator('.suite-picker summary').click();const nav=page.getByRole('navigation',{name:'Team 4418 apps'});
 await expect(nav.getByRole('link')).toHaveCount(5);await expect(nav.getByRole('link',{name:'Finance',exact:false})).toHaveAttribute('href',/https:\/\/finance.frc4418.org\/?$/);
 expect((await nav.boundingBox())!.height).toBeLessThan(400);
 await page.screenshot({path:`test-results/suite-menu-${width}.png`,fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.keyboard.press('Escape');await expect(nav).toBeHidden();await expect(page.locator('.suite-picker summary')).toBeFocused();
});
