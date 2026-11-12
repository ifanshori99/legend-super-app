#!/usr/bin/env node
/* global window, document -- used only inside page.evaluate callbacks */
// UI check for the HRIS request screens and the owner support-access screens
// (539-U4, beads legend-ydf2 and legend-8r77t). Same method as ui-check.mjs:
// for every screen/state below, at 390x844 and 1280x800, open the page in mock
// mode, drive it to the state, run axe (wcag2a, wcag2aa, wcag21aa, wcag22aa),
// fail on serious/critical violations, and save a screenshot to
// design/screenshots/hris-requests/<screen>-<390|1280>.png.
//
//   UI_CHECK_URL=http://localhost:5744 heavy node scripts/ui-check-539-u4.mjs
//   UI_CHECK_URL=... node scripts/ui-check-539-u4.mjs swap-sukses owner-menunggu
//
// UI_CHECK_URL must be a web server started with VITE_API_MOCK=true (env of
// playwright.mock.config.ts; WEB_URL must equal this URL). Never point it at a
// real deployment. Roles come from the cookie `legend-mock-role`
// (employee, hr, owner, super_admin; the supervisor template has no
// dashboard.management.view, so the queue is checked as HR); the signed-in employee is CL-1003.
// States are forced with ?mock=empty, by driving the UI, or by
// `context.setOffline`. The in-browser mock store resets on every page load,
// so each screen gets a fresh browser context.
//
// The swap screens inject sample shifts for CL-1003 (+1/+3/+5 days) and two
// colleagues into the in-page mock roster (see openSwapFormWithSampleShifts).
// Not covered: leave attachment upload (no endpoint), the Super Admin submit
// path. The swap screens use the `all` role (the mock serves peers only to
// `all`/hr, and hr cannot open /karyawan).
import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "design/screenshots/hris-requests");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);
const VIEWPORTS = [
  { label: "390", width: 390, height: 844 },
  { label: "1280", width: 1280, height: 800 },
];
const ROLE_COOKIE = "legend-mock-role";
const SUPPORT_COOKIE = "legend-mock-support";
const COLD_TIMEOUT = 60_000; // Vite compiles a route on its first request.
// Seeded swap 7401 (pending, breaks a work-time rule), see features/hris-requests/mock.ts.
const SWAP_7401 = "00000000-0000-4000-8000-000000007401";

function isoDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// `role` is the cookie value. `cookies` adds extra cookies. `prepare(page,
// context)` drives the state and ends with something that proves it is on screen.
const SCREENS = [
  // ---- Employee: new request form ----------------------------------------
  {
    name: "form-swap",
    // Swap candidates (peers) are only served to `all`/hr roles in the mock,
    // and hr has no access to /karyawan (404), so this uses `all`.
    role: "all",
    path: "/karyawan/libur",
    prepare: async (p) => {
      await openSwapFormWithSampleShifts(p);
      await pickFirst(p, 1);
      await pickFirst(p, 2);
      await pickFirst(p, 3);
    },
  },
  {
    name: "form-leave",
    role: "employee",
    path: "/karyawan/pengajuan/baru?jenis=leave",
    prepare: (p) => expectText(p, "Ajukan cuti atau izin", { heading: true }),
  },
  {
    name: "form-overtime",
    role: "employee",
    path: "/karyawan/pengajuan/baru?jenis=overtime",
    prepare: (p) => expectText(p, "Ajukan lembur", { heading: true }),
  },
  {
    name: "form-swap-sukses",
    role: "all", // peers only appear for `all`/hr in the mock; hr gets 404 on /karyawan
    path: "/karyawan/libur",
    prepare: async (p) => {
      await openSwapFormWithSampleShifts(p);
      await fillSwap(p);
      await clickButton(p, "Kirim pengajuan");
      await expectText(p, "Pengajuan terkirim");
    },
  },
  {
    name: "form-leave-sukses",
    role: "employee",
    path: "/karyawan/pengajuan/baru?jenis=leave",
    prepare: async (p) => {
      await fillLeave(p);
      await clickButton(p, "Kirim pengajuan");
      await expectText(p, "Pengajuan terkirim");
    },
  },
  {
    name: "form-overtime-sukses",
    role: "employee",
    path: "/karyawan/pengajuan/baru?jenis=overtime",
    prepare: async (p) => {
      await fillOvertime(p);
      await clickButton(p, "Kirim pengajuan");
      await expectText(p, "Pengajuan terkirim");
    },
  },
  {
    name: "form-offline",
    role: "employee",
    path: "/karyawan/pengajuan/baru?jenis=overtime",
    prepare: async (p, context) => {
      await fillOvertime(p);
      await context.setOffline(true);
      await clickButton(p, "Kirim pengajuan");
      await expectText(p, "Pengajuan tersimpan di layar ini");
    },
  },
  // ---- Employee: my requests + holidays ----------------------------------
  {
    name: "saya-isi",
    role: "employee",
    path: "/karyawan/pengajuan",
    prepare: (p) => expectText(p, "Daftar pengajuan saya", { anyRole: true }),
  },
  {
    // The seeded rows have no rejected one: a filed swap is rejected in the
    // supervisor mock only. Shows the list with its seeded statuses and, when
    // present, the "Pengajuan ditolak" notice.
    name: "saya-status",
    role: "employee",
    path: "/karyawan/pengajuan",
    prepare: async (p) => {
      await expectText(p, "Daftar pengajuan saya", { anyRole: true });
      await expectText(p, /Disetujui|Menunggu|Ditolak/);
    },
  },
  {
    name: "saya-kosong",
    role: "employee",
    path: "/karyawan/pengajuan?mock=empty",
    prepare: (p) => expectText(p, "Belum ada pengajuan"),
  },
  {
    name: "libur",
    role: "employee",
    path: "/karyawan/libur",
    prepare: (p) => expectText(p, "Kalender libur", { heading: true }),
  },
  // ---- Supervisor: queue + detail ----------------------------------------
  {
    name: "antrean",
    role: "hr",
    path: "/kelola/pengajuan",
    prepare: (p) => expectText(p, "Perlu ditinjau"),
  },
  {
    name: "antrean-kosong",
    role: "hr",
    path: "/kelola/pengajuan?mock=empty",
    prepare: (p) => expectText(p, "Tidak ada pengajuan untuk ditinjau"),
  },
  {
    name: "antrean-offline",
    role: "hr",
    path: "/kelola/pengajuan",
    prepare: async (p, context) => {
      await expectText(p, "Perlu ditinjau");
      await context.setOffline(true);
      await expectText(p, "Tidak ada koneksi");
    },
  },
  {
    name: "detail",
    role: "hr",
    path: `/kelola/pengajuan/swap/${SWAP_7401}`,
    prepare: (p) => expectText(p, "Periksa aturan jam kerja"),
  },
  {
    name: "detail-tolak",
    role: "hr",
    path: `/kelola/pengajuan/swap/${SWAP_7401}`,
    prepare: async (p) => {
      await clickButton(p, /^Tolak$/);
      await expectText(p, "Tolak pengajuan");
    },
  },
  {
    name: "detail-tolak-sukses",
    role: "hr",
    path: `/kelola/pengajuan/swap/${SWAP_7401}`,
    prepare: async (p) => {
      await clickButton(p, /^Tolak$/);
      await expectText(p, "Tolak pengajuan");
      await clickButton(p, "Kirim penolakan");
      await expectText(p, "Keputusan tersimpan");
    },
  },
  {
    name: "detail-offline",
    role: "hr",
    path: `/kelola/pengajuan/swap/${SWAP_7401}`,
    prepare: async (p, context) => {
      await expectText(p, "Periksa aturan jam kerja");
      await context.setOffline(true);
      // A decision attempted offline is not sent: the panel offers a retry.
      await clickButton(p, /^Tolak$/);
      await clickButton(p, "Kirim penolakan");
      await expectText(p, "Pengajuan belum diproses");
    },
  },
  // ---- Owner: support access requests ------------------------------------
  {
    name: "owner-menunggu",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan",
    prepare: (p) => expectText(p, "Diminta oleh"),
  },
  {
    name: "owner-setujui-dialog",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan",
    prepare: async (p) => {
      await clickButton(p, "Setujui akses");
      await expectText(p, "Setujui akses baca dan ubah?");
    },
  },
  {
    name: "owner-aktif",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan",
    prepare: async (p) => {
      await approveOwner(p);
      await expectText(p, "Akses aktif");
    },
  },
  {
    name: "owner-cabut-dialog",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan",
    prepare: async (p) => {
      await approveOwner(p);
      await expectText(p, "Akses aktif");
      await clickButton(p, "Cabut akses");
      await expectText(p, "Cabut akses dukungan?");
    },
  },
  {
    name: "owner-ditolak",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan",
    prepare: async (p) => {
      await clickButton(p, /^Tolak$/);
      await expectText(p, "Permintaan ditolak.");
    },
  },
  {
    // Seeded history holds a rejected and an expired request.
    name: "owner-kedaluwarsa",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan",
    prepare: async (p) => {
      await expectText(p, "Riwayat permintaan");
      await expectText(p, "Kedaluwarsa");
    },
  },
  {
    name: "owner-kosong",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan?mock=empty",
    prepare: (p) => expectText(p, "Tidak ada permintaan menunggu"),
  },
  {
    name: "owner-offline",
    role: "owner",
    path: "/kelola/akses-dukungan/permintaan",
    prepare: async (p, context) => {
      await expectText(p, "Diminta oleh");
      await context.setOffline(true);
      await expectText(p, "Tombol keputusan nonaktif sampai koneksi kembali.");
    },
  },
  {
    name: "owner-impersonate",
    role: "owner",
    cookies: [{ name: SUPPORT_COOKIE, value: "read_only" }],
    path: "/kelola/akses-dukungan/permintaan",
    prepare: async (p) => {
      await expectText(p, /sesi penyamaran/i);
      const approve = p.getByRole("button", { name: "Setujui akses" }).first();
      await approve.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
      if (await approve.isEnabled())
        throw new Error("approve button must be disabled while impersonating");
    },
  },
  // ---- Super Admin: read_write request form ------------------------------
  {
    name: "superadmin-readwrite",
    role: "super_admin",
    path: "/platform/akses-dukungan",
    prepare: async (p) => {
      await clickButton(p, /Minta akses/);
      await expectText(p, "Minta akses dukungan");
      await p.locator("#support-request-scope").click();
      await p.getByRole("option", { name: /Baca dan tulis/ }).click();
      await expectText(p, /persetujuan owner/i);
    },
  },
];

// ---- helpers -----------------------------------------------------------------

function textMatcher(text) {
  return typeof text === "string" ? new RegExp(escapeRegExp(text)) : text;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectText(
  page,
  text,
  { heading = false, anyRole = false } = {},
) {
  const target = heading
    ? page.getByRole("heading", { name: textMatcher(text) })
    : anyRole
      ? page.getByLabel(textMatcher(text))
      : page.getByText(textMatcher(text));
  await target.first().waitFor({ state: "visible", timeout: COLD_TIMEOUT });
}
async function clickButton(page, name) {
  const button = page.getByRole("button", { name }).first();
  await button.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await button.click();
}
/** Opens the nth combobox and takes its first option. */
async function pickFirst(page, index) {
  const box = page.getByRole("combobox").nth(index);
  await box.waitFor({ state: "visible", timeout: COLD_TIMEOUT });
  await page.waitForFunction(
    (i) => {
      const boxes = document.querySelectorAll('[role="combobox"]');
      return !boxes[i]?.hasAttribute("disabled");
    },
    index,
    { timeout: COLD_TIMEOUT },
  );
  await box.click();
  await page.getByRole("option").first().click();
}
/**
 * The mock has no upcoming shift for CL-1003. Mock handlers run inside the page
 * (no network, so `page.route` cannot see them): push sample rows into the
 * roster array the handler reads (same module instance as the app), then
 * client-navigate to the form so the app's first read of shifts sees them.
 * Starts on /karyawan/libur because that page does not read shifts.
 */
async function openSwapFormWithSampleShifts(page) {
  await expectText(page, "Kalender libur", { heading: true });
  await page.evaluate(
    async (days) => {
      const directory =
        await import("/src/lib/mock/handlers/hris-directory.ts");
      const roster = directory.MOCK_SHIFT_ASSIGNMENTS;
      const me = directory.MOCK_ME;
      const base = roster.find((row) => row.employeeId === me.id) ?? roster[0];
      const peers = [
        ...new Set(
          roster
            .filter((row) => row.outletId === base.outletId)
            .map((row) => row.employeeId)
            .filter((id) => id !== me.id),
        ),
      ].slice(0, 2);
      let n = 0;
      for (const offset of days) {
        const date = new Date(Date.now() + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        for (const employeeId of [me.id, ...peers]) {
          n += 1;
          roster.push({
            ...structuredClone(base),
            id: `00000000-0000-4000-8000-${String(9500 + n).padStart(12, "0")}`,
            employeeId,
            businessDate: date,
            segments: base.segments.map((segment) => ({
              startsAt: `${date}T${segment.startsAt.slice(11)}`,
              endsAt: `${date}T${segment.endsAt.slice(11)}`,
            })),
            status: "published",
          });
        }
      }
    },
    [1, 3, 5],
  );
  await page
    .getByRole("link", { name: /Pengajuan saya/ })
    .first()
    .click();
  await page
    .getByRole("link", { name: /Buat pengajuan/ })
    .first()
    .click();
  await expectText(page, "Ajukan tukar / ganti shift", { heading: true });
}
async function fillSwap(page) {
  await expectText(page, "Ajukan tukar / ganti shift", { heading: true });
  await pickFirst(page, 1); // my shift (0 is the kind)
  await pickFirst(page, 2); // peer
  await pickFirst(page, 3); // peer shift
}
async function fillLeave(page) {
  await expectText(page, "Ajukan cuti atau izin", { heading: true });
  await pickFirst(page, 0);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill(isoDate(30));
  await dates.nth(1).fill(isoDate(31));
  await page.locator("textarea").first().fill("Keperluan keluarga");
}
async function fillOvertime(page) {
  await expectText(page, "Ajukan lembur", { heading: true });
  await page.locator('input[type="date"]').first().fill(isoDate(2));
  const times = page.locator('input[type="time"]');
  await times.nth(0).fill("17:00");
  await times.nth(1).fill("19:00");
  await page.locator("textarea").first().fill("Persiapan acara outlet");
}
/** Approves the pending request through the confirm dialog. */
async function approveOwner(page) {
  await clickButton(page, "Setujui akses");
  await expectText(page, "Setujui akses baca dan ubah?");
  await page.getByRole("button", { name: "Ya, setujui akses" }).click();
}

async function loadAxe() {
  const require = createRequire(import.meta.url);
  try {
    const { AxeBuilder } = await import("@axe-core/playwright");
    return {
      run: async (page) =>
        (await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze())
          .violations,
    };
  } catch {
    // fall through to the bare axe-core bundle
  }
  let axePath = null;
  try {
    axePath = require.resolve("axe-core/axe.min.js");
  } catch {
    const store = join(ROOT, "node_modules/.pnpm");
    const hit = (await readdir(store).catch(() => [])).find((entry) =>
      entry.startsWith("axe-core@"),
    );
    if (hit) axePath = join(store, hit, "node_modules/axe-core/axe.min.js");
  }
  if (axePath === null)
    throw new Error(
      "Neither @axe-core/playwright nor axe-core is installed. Not adding dependencies on my own: ask the owner to add @axe-core/playwright as a devDependency.",
    );
  return {
    run: async (page) => {
      await page.addScriptTag({ path: axePath });
      return page.evaluate(
        async (tags) =>
          (
            await window.axe.run(document, {
              runOnly: { type: "tag", values: tags },
            })
          ).violations,
        AXE_TAGS,
      );
    },
  };
}

async function waitForHydration(page) {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true",
    undefined,
    { timeout: COLD_TIMEOUT },
  );
}

async function settleAnimations(page) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.effect?.getComputedTiming().iterations === Infinity ||
              animation.playState === "finished",
          ),
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {});
}

// ---- main --------------------------------------------------------------------

async function main() {
  const baseUrl = process.env.UI_CHECK_URL?.replace(/\/+$/, "");
  if (!baseUrl) {
    console.error(
      "Set UI_CHECK_URL to a web server running with VITE_API_MOCK=true, e.g. UI_CHECK_URL=http://localhost:3225",
    );
    process.exit(2);
  }
  const only = new Set(process.argv.slice(2));
  const screens = SCREENS.filter((s) => only.size === 0 || only.has(s.name));
  if (screens.length === 0) {
    console.error(`No screen matches: ${[...only].join(", ")}`);
    process.exit(2);
  }

  const axe = await loadAxe();
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const screen of screens) {
      for (const viewport of VIEWPORTS) {
        const id = `${screen.name}-${viewport.label}`;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        await context.addCookies([
          { name: ROLE_COOKIE, value: screen.role, url: baseUrl },
          ...(screen.cookies ?? []).map((c) => ({ ...c, url: baseUrl })),
        ]);
        const page = await context.newPage();
        try {
          const path = screen.path;
          await page.goto(`${baseUrl}${path}`, {
            waitUntil: "domcontentloaded",
          });
          await waitForHydration(page);
          await screen.prepare(page, context);
          // Dialogs fade in: axe must not measure contrast mid-animation.
          await settleAnimations(page);
          const violations = await axe.run(page);
          const blocking = violations.filter((v) =>
            BLOCKING_IMPACTS.has(v.impact ?? ""),
          );
          await page.screenshot({
            path: join(OUT_DIR, `${id}.png`),
            fullPage: true,
          });
          if (blocking.length === 0) {
            console.log(
              `PASS ${id}${violations.length ? ` (${violations.length} minor/moderate)` : ""}`,
            );
          } else {
            console.log(`FAIL ${id}`);
            for (const v of blocking) {
              console.log(
                `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node)`,
              );
              for (const node of v.nodes.slice(0, 3))
                console.log(
                  `    ${node.target.join(" ")} :: ${node.html.slice(0, 110)} :: ${(node.any[0]?.message ?? "").slice(0, 150)}`,
                );
            }
            failures.push(id);
          }
        } catch (error) {
          console.log(
            `FAIL ${id}: ${error instanceof Error ? error.message : error}`,
          );
          await page
            .screenshot({
              path: join(OUT_DIR, `${id}.error.png`),
              fullPage: true,
            })
            .catch(() => {});
          failures.push(id);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(
    failures.length === 0
      ? `\nAll ${screens.length * VIEWPORTS.length} checks passed.`
      : `\n${failures.length} failed: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
