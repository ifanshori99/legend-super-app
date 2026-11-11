import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
for(const state of ['normal','empty','error','loading']){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(dir,'pos-extra-kds-v4ht-tabs.html')).href+'?screen='+state);
 await page.evaluate(()=>document.fonts.ready);
 const result=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,selected:document.querySelectorAll('[role=radio][aria-checked=true]').length,radios:document.querySelectorAll('[role=radio]').length}));
 if(result.width>1280||result.height>800||result.selected!==1||result.radios!==5||errors.length)throw Error(`${state}: ${JSON.stringify({result,errors})}`);
 await page.screenshot({path:path.join(dir,`pos-extra-kds-v4ht-${state}-1280.png`)});
 console.log(state,JSON.stringify(result));
}
await browser.close();
