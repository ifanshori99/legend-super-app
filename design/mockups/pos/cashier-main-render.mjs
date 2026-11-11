import { readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const modules=path.resolve(dir,'../../../node_modules/.pnpm');
const pkg=(await readdir(modules)).find(name=>name.startsWith('@playwright+test@'));
if(!pkg) throw new Error('Paket Playwright tidak ditemukan');
const { chromium }=await import(pathToFileURL(path.join(modules,pkg,'node_modules/@playwright/test/index.mjs')).href);
const browser=await chromium.launch({headless:true});
for(const [name,width,height,state] of [['desktop',1280,800,'main'],['mobile',390,844,'main'],['empty-desktop',1280,800,'empty'],['modifier-desktop',1280,800,'modifier'],['offline-desktop',1280,800,'offline'],['takeaway-desktop',1280,800,'takeaway'],['cart-mobile',390,844,'cart'],['modifier-mobile',390,844,'modifier'],['offline-mobile',390,844,'offline']]){
const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});let errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(dir+'/cashier-main.html').href+'?state='+state);await page.evaluate(()=>document.fonts.ready);const qa=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,brokenImages:[...document.images].filter(img=>!img.complete||!img.naturalWidth).map(img=>img.src)}));if(errors.length||qa.brokenImages.length||qa.scrollWidth>width||(width===1280&&qa.height>height))throw new Error(name+': '+JSON.stringify({errors,...qa}));await page.screenshot({path:dir+'/cashier-main-'+name+'.png'});console.log(name,JSON.stringify({errors,...qa}));await page.close();}
await browser.close();
