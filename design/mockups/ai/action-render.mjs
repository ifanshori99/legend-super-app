import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_BASE || new URL('../../../package.json', import.meta.url));
const { chromium } = require('@playwright/test');
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const browser=await chromium.launch({headless:true});
for (const name of ['action-detail','panduan']) for (const [kind,width] of [['desktop',1280],['mobile',390]]) {
 const page=await browser.newPage({viewport:{width,height:800},deviceScaleFactor:1});
 await page.goto(pathToFileURL(resolve(`design/mockups/ai/${name}.html`)).href);
 await page.evaluate(()=>document.fonts.ready);
 if(!await page.evaluate(()=>document.fonts.check('16px \"Plus Jakarta Sans\"'))) throw Error('Font unavailable');
 const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,height:document.documentElement.scrollHeight}));
 if(dimensions.scroll>width) throw Error(`${name} ${kind} horizontal overflow: ${JSON.stringify(dimensions)}`);
 await page.screenshot({path:`design/mockups/ai/${name}-${kind}.png`,fullPage:true});
 console.log(name,kind,JSON.stringify(dimensions)); await page.close();
}
await browser.close();
