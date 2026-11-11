import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for(const [device,width,height] of [['desktop',1280,1000],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 for(const state of ['codes','login','recovery','invalid','empty','error','loading','success']){
  await page.goto(pathToFileURL(path.join(dir,'mfa-recovery-sw980.html')).href+'?state='+state);
  await page.evaluate(()=>document.fonts.ready);
  const g=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,content:document.body.innerText.length}));
  if(g.scrollWidth>g.viewport||g.content<30)throw new Error(JSON.stringify({state,device,g}));
  await page.screenshot({path:path.join(dir,`mfa-recovery-sw980-${state}-${device}.png`),fullPage:true});
  console.log(state,device,JSON.stringify(g));
 }
 await page.close();
}
await browser.close();
