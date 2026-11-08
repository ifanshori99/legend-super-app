// Inspect rendering fallbacks and mathematical contrast of the actual glass tokens.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const dir=new URL('./',import.meta.url);
const qa=new URL('qa/',dir); await mkdir(qa,{recursive:true});
const browser=await chromium.launch({headless:true});
const checks=[];
for(const target of ['mobile','desktop']) {
  const page=await browser.newPage({viewport:{width:target==='mobile'?390:1440,height:target==='mobile'?844:900}});
  const url=new URL(target==='mobile'?'final-a-mobile.html?layar=menu':'final-a-desktop.html',dir).href;
  const snapshot=()=>page.evaluate(()=>[...document.querySelectorAll('.glass')].map(e=>{const c=getComputedStyle(e);return {className:e.className,background:c.backgroundColor,blur:c.backdropFilter,borderWidth:c.borderTopWidth};}));
  await page.goto(url); await page.evaluate(()=>document.fonts.ready);
  const normal=await snapshot();
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  const reducedMatches=await page.evaluate(()=>matchMedia('(prefers-reduced-transparency: reduce)').matches);
  const reduced=await snapshot();
  if(!reducedMatches || reduced.some(s=>s.blur!=='none'||s.background.includes('rgba'))) throw Error(`${target}: reduced transparency fallback failed`);
  await page.screenshot({path:fileURLToPath(new URL(`final-a-${target}-reduced-transparency.png`,qa))});
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-contrast',value:'more'}]});
  const contrast=await snapshot();
  if(contrast.some(s=>s.blur!=='none'||s.borderWidth!=='2px'||s.background.includes('rgba'))) throw Error(`${target}: more contrast fallback failed`);
  await page.screenshot({path:fileURLToPath(new URL(`final-a-${target}-high-contrast.png`,qa))});
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});
  const source=target==='mobile'?await readFile(new URL('final-a-mobile.css',dir),'utf8'):(await readFile(new URL('final-a-desktop.html',dir),'utf8')).match(/<style>([\s\S]*?)<\/style>/)[1];
  // Force only the existing no-support fallback selector. This checks the
  // branch's declarations; it does not claim a real legacy engine was tested.
  await page.addStyleTag({content:source.replace(/@supports not\s*\(backdrop-filter:\s*blur\(1px\)\)/g,'@supports (display:block)')});
  const noSupportBranch=await snapshot();
  if(noSupportBranch.some(s=>s.blur!=='none'||s.background.includes('rgba'))) throw Error(`${target}: forced no-support branch failed`);
  checks.push({target,normal,reducedMatches,reduced,contrast,noSupportBranch});
  await page.close();
}
await browser.close();
function lum(rgb){return rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);}
function ratio(a,b){const lo=Math.min(lum(a),lum(b)),hi=Math.max(lum(a),lum(b));return(hi+.05)/(lo+.05);}
const contrast=[];
for(const [name,color,alpha,text] of [['light-ink',[255,252,247],.88,[43,33,27]],['light-secondary',[255,252,247],.88,[75,59,48]],['dark-white',[57,37,27],.90,[255,255,255]]]){
  for(const backdrop of [0,255]){
    const composite=color.map(x=>x*alpha+backdrop*(1-alpha));
    const value=ratio(composite,text);if(value<4.5)throw Error(`Contrast failed: ${name}`);
    contrast.push({name,backdrop:backdrop===0?'black':'white',ratio:Number(value.toFixed(2))});
  }
}
await writeFile(new URL('verification-final-a-glass.json',dir),JSON.stringify({fallbackChecks:checks,contrast,noSupportScope:'Forced CSS fallback branch; no legacy browser run.'},null,2)+'\n');
console.log(JSON.stringify({fallbackTargets:checks.map(x=>x.target),reducedTransparency:'PASS',highContrast:'PASS',forcedNoSupportBranch:'PASS',contrast},null,2));
