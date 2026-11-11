import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_BASE || new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for(const [size,width,height] of [['desktop',1280,800],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 for(const [suffix,state] of [['',''],['-tidak-tersedia','unavailable'],['-hapus-riwayat','delete'],['-akses-ditolak','denied']]){
  await page.goto(pathToFileURL(path.join(dir,'tanya-ai.html')).href+'?state='+state);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(dir,`tanya-ai${suffix}-${size}.png`),fullPage:true});
  console.log(size,state||'answer',await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})));
 }
 await page.close();
}
await browser.close();
