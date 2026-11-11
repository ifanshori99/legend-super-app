import {chromium} from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
for(const state of ['normal','empty','error','loading','save-error','success']){
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(dir,'pos-extra-kds-sonf-konfigurasi.html')).href+'?screen='+state);
 await page.evaluate(()=>document.fonts.ready);
 const dimensions=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,visible:document.querySelectorAll('.state.active').length}));
 if(errors.length||dimensions.width>1280||dimensions.visible!==1) throw Error(`${state}: ${JSON.stringify({errors,dimensions})}`);
 await page.screenshot({path:path.join(dir,`pos-extra-kds-sonf-${state}-1280.png`),fullPage:true});
 console.log(state,JSON.stringify(dimensions));
}
await browser.close();
