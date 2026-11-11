import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
for(const state of ['tables','order','review','held','calls','offline']){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(dir,'captain.html')).href+'?screen='+state);
 await page.evaluate(()=>document.fonts.ready);
 const active=await page.locator('.screen.active').count();
 const overflow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
 if(active!==1||overflow.width>390||overflow.height>844||errors.length)throw Error(`${state}: ${JSON.stringify({active,overflow,errors})}`);
 await page.screenshot({path:path.join(dir,`captain-${state}.png`)});
 console.log(state,JSON.stringify(overflow));
}
await browser.close();
