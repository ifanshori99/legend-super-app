import { chromium } from '../../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const url=pathToFileURL(path.join(dir,'wfc.html')).href;
const browser=await chromium.launch({headless:true});
const first=await browser.newPage();await first.goto(url);
const screens=await first.evaluate(()=>Object.keys(window.SCREENS));await first.close();
let bad=0;
for(const screen of screens)for(const width of [1280,390,320]){
 const page=await browser.newPage({viewport:{width,height:width===1280?800:844},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push('gagal '+r.url()));
 await page.goto(url+'?screen='+screen);await page.evaluate(()=>document.fonts.ready);
 const r=await page.evaluate(()=>{
  const out=[];
  if(document.documentElement.scrollWidth>innerWidth)out.push('luapan '+document.documentElement.scrollWidth);
  const seen=new Set();
  for(const el of document.querySelectorAll('button,a,input[type=radio],.pill,h1,h2,h3,td,th,dd,dt,.ex,.nw')){
   if(!el.checkVisibility())continue;const b=el.getBoundingClientRect();
   if(b.right>innerWidth+1||b.left<-1)out.push('keluar layar: '+el.textContent.trim().slice(0,40));
   if(el.matches('button,a')&&(b.height<43.5||b.width<43.5))out.push('target kecil: '+el.textContent.trim().slice(0,30)+` ${b.width|0}x${b.height|0}`);
   if(el.matches('button,a,.pill')&&el.scrollWidth>el.clientWidth+1)out.push('terpotong: '+el.textContent.trim().slice(0,40));
  }
  // Teks yang keluar dari kartu induknya.
  for(const p of document.querySelectorAll('.panel,.prod,.guest,dialog,.credit,.notice,.chip,.seat,.cta')){
   if(!p.checkVisibility())continue;const pb=p.getBoundingClientRect();
   const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);
   while(w.nextNode()){const n=w.currentNode;if(!n.textContent.trim()||!n.parentElement.checkVisibility())continue;const g=document.createRange();g.selectNodeContents(n);
    for(const q of g.getClientRects())if(q.width>1&&(q.right>pb.right+1||q.left<pb.left-1)&&getComputedStyle(n.parentElement).clipPath==='none'){const k=n.textContent.trim().slice(0,40);if(!seen.has(k)){seen.add(k);out.push('keluar kartu: '+k)}}}
  }
  return out;
 });
 const modal=await page.evaluate(()=>!!document.querySelector('dialog[open]'));
 // Tinggi layar disamakan dengan isi supaya bar lengket terpotret di bawah. Dialog memakai tinggi layar.
 if(!modal){const height=await page.evaluate(()=>document.documentElement.scrollHeight);await page.setViewportSize({width,height})}
 if(width!==320)await page.screenshot({path:path.join(dir,`${screen}-${width}.png`),fullPage:!modal});
 const all=[...errors,...r];if(all.length)bad++;
 console.log(`${screen} ${width}: ${all.length?all.join(' | '):'OK'}`);await page.close();
}
await browser.close();console.log(`${screens.length} layar, ${bad} bermasalah`);
