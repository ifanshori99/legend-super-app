import { chromium } from "../../../node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
for (const screen of ["kebijakan", "thr-baru", "kosong", "thr-kosong", "validasi", "thr-validasi", "memuat", "entitas-kosong", "entitas-gagal", "simpan-gagal", "thr-simpan-gagal", "sukses", "thr-sukses"]) {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.join(dir, "payroll-wpqs.html")).href + "?screen=" + screen);
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`Horizontal overflow: ${screen} ${width}`);
    await page.screenshot({ path: path.join(dir, `payroll-wpqs-${screen}-${width === 390 ? "mobile" : "desktop"}.png`), fullPage: true });
    console.log(`${screen} ${width}: OK`);
    await page.close();
  }
}
await browser.close();
