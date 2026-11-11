import { chromium } from '../../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules/@playwright/test/index.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
for (const [device,width,height] of [['desktop',1280,1000],['mobile',390,844]]) {
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 for (const state of ['normal','empty','assign','replace','validation','error','loading','success']) {
  await page.goto(pathToFileURL(path.join(dir,'owner-be0lx.html')).href+'?state='+state);
  await page.evaluate(()=>document.fonts.ready);
  const geometry=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,content:document.body.innerText.length}));
  if(geometry.scrollWidth>geometry.viewport||geometry.content<80)throw new Error(JSON.stringify({state,device,geometry}));
  await page.screenshot({path:path.join(dir,`owner-be0lx-${state}-${device}.png`),fullPage:true});
  console.log(state,device,JSON.stringify(geometry));
 }
 await page.close();
}
const check=await browser.newPage({viewport:{width:390,height:844}});
await check.goto(pathToFileURL(path.join(dir,'owner-be0lx.html')).href+'?state=normal');
await check.getByRole('button',{name:'Ganti Owner'}).click();
if(!check.url().includes('state=replace'))throw new Error('Tombol penggantian gagal');
await check.getByRole('button',{name:'Ganti Owner'}).click();
if(!(await check.getByText('Masukkan kode terbaru dari aplikasi autentikator.',{exact:true}).count()))throw new Error('Validasi kode gagal');
await check.locator('#code').fill('123456');
await check.getByRole('button',{name:'Ganti Owner'}).click();
if(!check.url().includes('state=success'))throw new Error('Alur simpan gagal');
await check.goto(pathToFileURL(path.join(dir,'owner-be0lx.html')).href+'?state=empty');
await check.getByRole('button',{name:'Tetapkan Owner'}).click();
if(!check.url().includes('state=assign'))throw new Error('Tombol penetapan gagal');
console.log('Alur tombol dan validasi: lulus');
await browser.close();
