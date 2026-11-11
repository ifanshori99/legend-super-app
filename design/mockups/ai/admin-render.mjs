import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_BASE || new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for(const [device,width,height] of [['desktop',1280,800],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 for(const state of ['','revoke']){
  await page.goto(pathToFileURL(path.join(dir,'admin.html')).href+(state?'?state='+state:''));
  await page.evaluate(()=>document.fonts.ready);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw Error(`${device} horizontal overflow`);
  await page.screenshot({path:path.join(dir,`admin${state?'-'+state:''}-${device}.png`),fullPage:!state});
 }
 await page.close();
}
await browser.close();
