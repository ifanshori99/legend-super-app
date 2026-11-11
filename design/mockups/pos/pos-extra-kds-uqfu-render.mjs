import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
for(const state of ['normal','empty','error','loading','success']){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(dir,'pos-extra-kds-uqfu-scanner.html')).href+'?screen='+state);
 await page.evaluate(()=>document.fonts.ready);
 const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,feedback:document.querySelector('#feedback').innerText}));
 if(errors.length||result.overflow||!result.feedback)throw new Error(JSON.stringify({state,errors,result}));
 await page.screenshot({path:path.join(dir,`pos-extra-kds-uqfu-scanner-${state}-1280.png`),fullPage:true});
 console.log(state,JSON.stringify(result));
}
await browser.close();
