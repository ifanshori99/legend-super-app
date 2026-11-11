import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for(const [device,width,height] of [['desktop',1280,1000],['mobile',390,844]]) {
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 for(const state of ['normal','empty','loading','error','validation','success']) {
  await page.goto(pathToFileURL(path.join(dir,'account-role-mappings.html')).href+'?state='+state);
  await page.evaluate(()=>document.fonts.ready);
  const geometry=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,content:document.body.innerText.length}));
  if(geometry.scrollWidth>geometry.viewport||geometry.content<100)throw new Error(JSON.stringify({state,device,geometry}));
  await page.screenshot({path:path.join(dir,`account-role-mappings-${state}-${device}.png`),fullPage:true});
  console.log(state,device,JSON.stringify(geometry));
 }
 await page.close();
}
await browser.close();
