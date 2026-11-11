import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
let playwright;
try { playwright=require('@playwright/test'); } catch {
 const store=path.resolve('node_modules/.pnpm');
 const entry=(await readdir(store)).find(name=>name.startsWith('@playwright+test@'));
 if(!entry) throw new Error('Install @playwright/test before rendering');
 playwright=require(path.join(store,entry,'node_modules/@playwright/test'));
}
const { chromium }=playwright;
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for(const state of ['ditolak','normal','kosong','memuat','error','hapus','ubah']){
 const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 await page.goto(pathToFileURL(path.join(dir,'hris-nvc7-koreksi.html')).href+'?screen='+state);
 await page.evaluate(()=>document.fonts.ready);
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error(`Horizontal overflow: ${state}`);
 await page.screenshot({path:path.join(dir,`hris-nvc7-${state}-mobile.png`),fullPage:true});
 console.log(`${state} 390: OK`);await page.close();
}
const narrow=await browser.newPage({viewport:{width:320,height:844}});
await narrow.goto(pathToFileURL(path.join(dir,'hris-nvc7-koreksi.html')).href+'?screen=ditolak');
if(await narrow.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Horizontal overflow: 320');
console.log('ditolak 320: OK');
await browser.close();
