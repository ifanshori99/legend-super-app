import { chromium } from '../../../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const screens=['banner','pin','pin-salah','tanpa-internet','hitung-laci','kasir-cloud','tutup-hari','bo-edge','bo-konfirmasi','bo-aktif','kembali','kembali-siap','kembali-selesai'];
const dialogs=new Set(['pin','pin-salah','tanpa-internet','bo-konfirmasi']);
for(const screen of screens){
 for(const width of [1280,390,320]){
  const page=await browser.newPage({viewport:{width,height:width===1280?800:844},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.join(dir,'failover.html')).href+'?screen='+screen);
  await page.evaluate(()=>document.fonts.ready);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow||errors.length)throw new Error(`${screen} ${width}: overflow=${overflow} ${errors.join('; ')}`);
  // Tinggi layar disamakan dengan isi supaya bar lengket terpotret di bawah. Dialog memakai tinggi layar.
  if(!dialogs.has(screen)){const height=await page.evaluate(()=>document.documentElement.scrollHeight);await page.setViewportSize({width,height:Math.max(height,width===1280?800:844)});}
  // 320 hanya diperiksa luapannya.
  if(width!==320)await page.screenshot({path:path.join(dir,`${screen}-${width}.png`),fullPage:!dialogs.has(screen)});
  console.log(`${screen} ${width}: OK`);await page.close();
 }
}
await browser.close();
