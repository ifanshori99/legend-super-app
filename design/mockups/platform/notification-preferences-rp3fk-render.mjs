import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for(const [device,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 for(const state of ['normal','loading','empty','error','success','save-error','validation']){
  await page.goto(pathToFileURL(path.join(dir,'notification-preferences-rp3fk.html')).href+'?state='+state);
  await page.evaluate(()=>document.fonts.ready);
  const geometry=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}));
  if(geometry.scrollWidth>geometry.viewport)throw new Error(JSON.stringify({state,device,geometry}));
  if(['normal','success','save-error','validation'].includes(state)){
   const locked=page.getByRole('switch',{name:'Email Keamanan'});if(!await locked.isChecked()||!await locked.isDisabled())throw new Error('Security email is not locked on');
  }
  await page.screenshot({path:path.join(dir,`notification-preferences-rp3fk-${state}-${device}.png`),fullPage:true});
  console.log(state,device,JSON.stringify(geometry));
 }
 await page.close();
}
await browser.close();
