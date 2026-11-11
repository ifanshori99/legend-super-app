import { chromium } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const screens=['cuti','tukar','ganti','lembur','sukses','ditolak','offline','kosong','queue','detail','queue-empty','queue-success','queue-reject','queue-offline'];
for(const screen of screens){
 for(const width of (screen.startsWith('queue')||screen==='detail'?[1280,390]:[390])){
  const page=await browser.newPage({viewport:{width,height:844},deviceScaleFactor:1});
  const errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.join(dir,'hris.html')).href+'?screen='+screen);
  await page.evaluate(()=>document.fonts.ready);
  if(errors.length)throw new Error(`Page errors: ${screen} ${errors.join('; ')}`);
  if((await page.locator('#app').innerText()).trim().length<100)throw new Error(`Empty screen: ${screen}`);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw new Error(`Horizontal overflow: ${screen} ${width}`);
  await page.screenshot({path:path.join(dir,`${screen}-${width===390?'mobile':'desktop'}.png`),fullPage:true});
  console.log(`${screen} ${width}: OK`);await page.close();
 }
}
await browser.close();
