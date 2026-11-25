import { chromium } from '../../../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const screens=['isi','ditahan','kosong','galat','memuat','detail','konfirmasi','terkirim','belum-pasti'];
for(const screen of screens){
 for(const width of [1280,390,320]){
  const page=await browser.newPage({viewport:{width,height:width===1280?800:844},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.join(dir,'pesanan-terbuka.html')).href+'?screen='+screen);
  await page.evaluate(()=>document.fonts.ready);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow||errors.length)throw new Error(`${screen} ${width}: overflow=${overflow} ${errors.join('; ')}`);
  // Tinggi layar disamakan dengan isi supaya bar lengket terpotret di bawah.
  if(screen!=='konfirmasi'){const height=await page.evaluate(()=>document.documentElement.scrollHeight);await page.setViewportSize({width,height});}
  // 320 hanya diperiksa luapannya. Dialog memakai tinggi layar, bukan seluruh halaman.
  if(width!==320)await page.screenshot({path:path.join(dir,`${screen}-${width}.png`),fullPage:screen!=='konfirmasi'});
  console.log(`${screen} ${width}: OK`);await page.close();
 }
}
await browser.close();
