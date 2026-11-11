import { chromium } from '@playwright/test';
import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
const scriptErrors=[];page.on('pageerror',e=>scriptErrors.push(e.message));
const report=[];
for(const file of (await readdir(dir)).filter(f=>f.endsWith('.html')&&!['cashier-main.html','captain.html'].includes(f)).sort()){
 await page.goto(pathToFileURL(path.join(dir,file)).href);
 const states=await page.locator('.screen').evaluateAll(els=>els.map(e=>e.dataset.screen));
 for(const state of states){
  scriptErrors.length=0;
  await page.goto(pathToFileURL(path.join(dir,file)).href+'?screen='+state);
  await page.locator('.screen.active').waitFor({state:'visible'});
  if(await page.locator('.screen.active').count()!==1)throw new Error('Expected exactly one active screen: '+file+' '+state);
  if(scriptErrors.length)throw new Error(scriptErrors.join('; '));
  await page.evaluate(()=>document.fonts.ready);
  const name=file.replace('.html','')+'-'+state+'.png';
  const qa=await page.evaluate(()=>{
   const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
   const els=[...document.querySelectorAll('.screen.active *, .topbar *')].filter(visible);
   const clipped=els.filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.top<-.5||r.right>1280.5||r.bottom>800.5}).map(e=>({tag:e.tagName,text:(e.textContent||'').trim().slice(0,70),rect:JSON.stringify(e.getBoundingClientRect())}));
   const color=s=>[...s.matchAll(/[\d.]+/g)].map(x=>Number(x[0]));
   const lum=a=>a.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
   const failures=[];let checked=0,min=100;
   for(const e of els){if(![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;
    const s=getComputedStyle(e);let bg=e,b;
    while(bg){b=color(getComputedStyle(bg).backgroundColor);if(b.length===3||b[3]>=.99)break;bg=bg.parentElement}
    if(!bg)continue;const fg=color(s.color);if(fg.length>3&&fg[3]<1)continue;
    const ratio=(Math.max(lum(fg),lum(b))+.05)/(Math.min(lum(fg),lum(b))+.05);checked++;min=Math.min(min,ratio);
    const big=parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&Number(s.fontWeight)>=700);
    if(ratio<(big?3:4.5))failures.push({text:e.textContent.trim().slice(0,80),ratio:+ratio.toFixed(2),fg:s.color,bg:getComputedStyle(bg).backgroundColor});
   }
   return {clipped,contrast:{checked,min:+min.toFixed(2),failures},font:getComputedStyle(document.body).fontFamily};
  });
  if(qa.contrast.checked<15)throw new Error('Insufficient rendered text: '+name);
  await page.screenshot({path:path.join(dir,name),fullPage:false});
  report.push({file:name,source:file,state,...qa});
  console.log(name,JSON.stringify({clipped:qa.clipped.length,contrastFailures:qa.contrast.failures.length}));
 }
}
await browser.close();
await writeFile(path.join(dir,'verification.json'),JSON.stringify({viewport:{width:1280,height:800},screens:report},null,2)+'\n');
if(report.some(r=>r.clipped.length||r.contrast.failures.length))process.exitCode=1;
