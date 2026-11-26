import { readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const modules=path.resolve(dir,'../../../../node_modules/.pnpm');
const pkg=(await readdir(modules)).find(name=>name.startsWith('@playwright+test@'));
if(!pkg) throw new Error('Paket Playwright tidak ditemukan');
const { chromium }=await import(pathToFileURL(path.join(modules,pkg,'node_modules/@playwright/test/index.mjs')).href);
const states=['banner','bayar','tersimpan','antrean','tutup','keluar','tanpa-bekal','shell'];
const browser=await chromium.launch({headless:true});
for(const state of states)for(const [width,height] of [[1280,800],[390,844]]){
const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(dir+'/offline.html').href+'?state='+state);await page.evaluate(()=>document.fonts.ready);
const qa=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,brokenImages:[...document.images].filter(img=>!img.complete||!img.naturalWidth).map(img=>img.src)}));
if(errors.length||qa.brokenImages.length||qa.scrollWidth>width||(width===1280&&qa.height>height))throw new Error(state+' '+width+': '+JSON.stringify({errors,...qa}));
await page.screenshot({path:`${dir}/offline-${state}-${width}.png`,fullPage:width<1280&&['antrean','tutup'].includes(state)});console.log(state,width,JSON.stringify(qa));await page.close();}
await browser.close();
