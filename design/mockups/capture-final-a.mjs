import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
const dir = new URL('./', import.meta.url);
const browser = await chromium.launch({ headless: true });
const screens = [
  ['menu-mobile','menu',844],['menu-awal-mobile','awal',844],
  ['jumlah-tamu-mobile','tamu',960],['detail-mobile','detail',844],
  ['checkout-mobile','checkout',844],['qris-menunggu-mobile','qris',844],
  ['kode-kasir-mobile','kasir',844],['berhasil-mobile','berhasil',844],
  ['stok-habis-mobile','habis',844],['menu-desktop','desktop',900],
];
const results = [];
for (const [name,screen,height] of screens) {
  const width = screen === 'desktop' ? 1440 : 390;
  const page = await browser.newPage({ viewport:{ width,height }, deviceScaleFactor:1 });
  const errors = [], failedRequests = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', r => failedRequests.push(r.url()));
  await page.goto(new URL(screen === 'desktop' ? 'final-a-desktop.html' : `final-a-mobile.html?layar=${screen}`,dir).href);
  await page.evaluate(() => document.fonts.ready);
  const checks = await page.evaluate(() => {
    const overlaps = (a,b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const viewport = {left:0,top:0,right:innerWidth,bottom:innerHeight};
    const panels = [...document.querySelectorAll('.glass,.network-notice')].filter(el => el.checkVisibility());
    const clipped = [], hidden = [];
    const walker = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const n=walker.currentNode;
      if(!n.textContent.trim() || !n.parentElement.checkVisibility() || ['SCRIPT','STYLE','TITLE'].includes(n.parentElement.tagName)) continue;
      const range=document.createRange(); range.selectNodeContents(n);
      for(const r of range.getClientRects()) {
        if(!overlaps(r,viewport)) continue; // Fully outside the captured scroll window is normal.
        if(r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) clipped.push(n.textContent.trim());
        for(const p of panels) if(!p.contains(n) && overlaps(r,p.getBoundingClientRect())) hidden.push(n.textContent.trim());
      }
    }
    const glasses = panels.filter(el => el.classList.contains('glass')).map(el => {
      const c=getComputedStyle(el),r=el.getBoundingClientRect();
      const photos=[...document.querySelectorAll('.photo,.photo-band,.top-photos,.backdrop')].filter(photo => !el.contains(photo) && !photo.contains(el) && overlaps(r,photo.getBoundingClientRect()));
      return { className:el.className, background:c.backgroundColor, blur:c.backdropFilter, photoUnderlay:photos.length > 0, bounds:{x:r.x,y:r.y,width:r.width,height:r.height} };
    });
    return { width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,fontLoaded:document.fonts.check('16px Jakarta'),clipped:[...new Set(clipped)],hiddenByFloating:[...new Set(hidden)],blurRegions:glasses.filter(g => g.blur !== 'none').length,glasses,missingImages:[...document.images].filter(x=>!x.complete||!x.naturalWidth).map(x=>x.src) };
  });
  const filename=`final-a-${name}.png`;
  await page.screenshot({ path:fileURLToPath(new URL(filename,dir)) });
  results.push({ filename,errors,failedRequests,...checks });
  await page.close();
}
await browser.close();
await writeFile(new URL('verification-final-a.json',dir),JSON.stringify(results,null,2)+'\n');
for(const r of results) console.log(JSON.stringify({ file:r.filename,size:`${r.width}x${r.height}`,errors:r.errors,failedRequests:r.failedRequests,clipped:r.clipped,hidden:r.hiddenByFloating,blurRegions:r.blurRegions,photosBehindGlass:r.glasses.filter(g=>g.photoUnderlay).length }));
const failures = results.filter(r => r.errors.length || r.failedRequests.length ||
  r.clipped.length || r.hiddenByFloating.length || r.missingImages.length ||
  !r.fontLoaded || r.documentWidth !== r.width || r.blurRegions > 2 ||
  !r.glasses.some(g => g.photoUnderlay));
if (failures.length) throw new Error(`Mockup verification failed: ${failures.map(r => r.filename).join(', ')}`);
