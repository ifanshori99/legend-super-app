// Warm-up for the mock-mode runner (beads legend-1336, legend-b0kq).
//
// `pnpm test:e2e:mock` starts a cold Vite dev server. Vite compiles a route's
// server module graph on the first SSR request and its client module graph on
// the first browser load; on a loaded machine that first hit took 20-35 s
// (legend-1336) and the first assertion of a spec (5 s default) expired while
// later tests on the same route passed, because the modules were warm by then.
//
// Playwright starts the webServer before globalSetup and the first test after
// it, so this setup opens every route area in a real Chromium page until the
// route answers and its client modules have loaded. Specs then run against a
// warm server and keep their normal timeouts. No per-spec sleeps.
//
// Keep the list in sync with apps/web/src/routes when a new area lands; the ids
// are the fixtures the existing mock specs use (legend-2m4 table token,
// legend-kaqr facility/ticket, legend-2w5 payment link).
import { chromium } from "@playwright/test";
import { MOCK_WEB_URL } from "./mock-server.ts";

/** Valid mock fixture ids, so every warmed route renders (not a not-found). */
const TABLE_TOKEN = `v1.${"C".repeat(40)}.${"D".repeat(43)}`; // table A01
const FACILITY_ID = "00000000-0000-4000-8000-000000009001"; // shower room
const TICKET_ID = "01JBQ7Z8K3M4N5P6Q7R8S9T0VX"; // in-use facility ticket
const PAYMENT_ID = "01JBQ7Z8K3M4N5P6Q7R8S9T0VY"; // any id: the page polls
const ISSUE_ID = "01JBQ7Z8K3M4N5P6Q7R8S9T0VZ"; // any id: the page polls
const PAYMENT_LINK = "pl_qris_4c8fa1d3e5b7c9f0a2d47b6c8fa1d3"; // QRIS pending

/** Every top-level route area plus the heavy QR / facility / payment journeys. */
const WARM_ROUTES: readonly string[] = [
  "/", // public landing
  "/sign-in",
  "/sign-up",
  "/design-system",
  "/notes", // protected area
  "/admin",
  "/kelola",
  "/kelola/menu",
  "/kelola/menu/kategori",
  "/kelola/menu/harga",
  "/kelola/menu/paket",
  "/kelola/menu/stasiun",
  "/kelola/menu/ketersediaan",
  "/kelola/meja",
  "/kelola/meja/qr",
  "/kelola/notifikasi",
  // WS-07 accounting back office (legend-53q/5fdy/m4zn/rx0h/ogx3).
  "/kelola/akuntansi",
  "/kelola/akuntansi/jurnal",
  "/kelola/akuntansi/jurnal-manual",
  "/kelola/akuntansi/jurnal-berulang",
  "/kelola/akuntansi/kas-bank",
  "/kelola/akuntansi/rekonsiliasi",
  "/kelola/akuntansi/pajak",
  "/kelola/akuntansi/piutang-utang",
  "/kelola/akuntansi/aset-tetap",
  "/kelola/akuntansi/anggaran",
  "/kelola/akuntansi/laporan",
  "/kelola/akuntansi/tutup-periode",
  "/kelola/akuntansi/bagi-hasil",
  "/kelola/akuntansi/bagi-hasil/distribusi",
  "/pos",
  "/pos/meja",
  "/operasional/koneksi",
  "/expo", // kitchen
  "/pickup",
  "/kds",
  "/owner",
  "/shareholder",
  "/platform",
  "/karyawan",
  `/t/${TABLE_TOKEN}`, // QR customer journey
  `/t/${TABLE_TOKEN}/cart`,
  `/t/${TABLE_TOKEN}/checkout`,
  `/t/${TABLE_TOKEN}/bill`,
  `/t/${TABLE_TOKEN}/orders`,
  `/t/${TABLE_TOKEN}/review`,
  `/t/${TABLE_TOKEN}/pay/${PAYMENT_ID}`,
  `/t/${TABLE_TOKEN}/issue/${ISSUE_ID}`,
  `/f/${FACILITY_ID}`, // facility QR entry
  "/member",
  "/member/fasilitas",
  "/member/fasilitas/langganan",
  `/member/fasilitas/${TICKET_ID}`,
  "/wifi",
  `/bayar/${PAYMENT_LINK}`, // customer payment link
  // WS-08 CRM squad (2026-11-03): Customer 360/segments/reviews, campaigns,
  // delivery ops, the guest booking flow and the staff reservation desk. Detail
  // routes are opened from their list by the specs, so they stay out here.
  "/kelola/pelanggan",
  "/kelola/pelanggan/segmen",
  "/kelola/ulasan",
  "/kelola/kampanye",
  "/kelola/kampanye/otomasi",
  "/kelola/delivery",
  "/reservasi",
  "/pos/reservasi",
];

/** Give up on one route after this; a cold compile has been seen at 35 s. */
const ROUTE_TIMEOUT_MS = 90_000;
/** The whole warm-up must fit inside the webServer timeout budget. */
const DEADLINE_MS = 240_000;
/** How many pages warm at once; more would only contend for Vite's compiler. */
const CONCURRENCY = 3;
/** One retry absorbs a compile flake; a route that is really broken is reported. */
const MAX_ATTEMPTS = 2;

interface WarmResult {
  route: string;
  status: number | null;
  error?: string;
}

async function warmRoute(
  context: import("@playwright/test").BrowserContext,
  route: string,
  deadline: number,
): Promise<WarmResult> {
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(ROUTE_TIMEOUT_MS);
  let status: number | null = null;
  let error: string | undefined;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (Date.now() >= deadline) break;
      try {
        const response = await page.goto(`${MOCK_WEB_URL}${route}`, {
          // networkidle: SSR answered and the browser fetched every module the
          // page needs, which is exactly the work the first test would pay for.
          waitUntil: "networkidle",
        });
        status = response?.status() ?? null;
        error = undefined;
        if (status !== null && status < 400) return { route, status };
      } catch (caught) {
        status = null;
        error = caught instanceof Error ? caught.message : String(caught);
      }
      if (attempt + 1 < MAX_ATTEMPTS) await page.waitForTimeout(500);
    }
    return {
      route,
      status,
      error:
        error ?? (Date.now() >= deadline ? "deadline exceeded" : undefined),
    };
  } finally {
    await page.close();
  }
}

export default async function warmMockServer() {
  const startedAt = Date.now();
  const deadline = startedAt + DEADLINE_MS;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const results: WarmResult[] = [];
    let next = 0;
    const worker = async () => {
      while (next < WARM_ROUTES.length) {
        const route = WARM_ROUTES[next++]!;
        results.push(await warmRoute(context, route, deadline));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const failed = results.filter(
      (result) => result.status === null || result.status >= 500,
    );
    if (failed.length > 0) {
      throw new Error(
        `Mock dev server did not warm ${failed.length} route(s):\n${failed
          .map(
            (result) => `  ${result.route}: ${result.error ?? result.status}`,
          )
          .join("\n")}`,
      );
    }
    // A 4xx means the route compiled but that fixture is unknown to mock mode;
    // it is not this runner's failure, but it makes a spec on that route flaky.
    const notFound = results.filter((result) => (result.status ?? 0) >= 400);
    for (const result of notFound)
      console.warn(
        `[mock-global-setup] ${result.route} answered ${result.status}`,
      );
    console.log(
      `[mock-global-setup] warmed ${results.length} routes in ${Math.round(
        (Date.now() - startedAt) / 1000,
      )}s`,
    );
  } finally {
    await browser.close();
  }
}
