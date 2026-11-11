# Brief subagent: UI campuran Q36 (ws/ui-mixed-q36)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ui-mixed-q36`. Kerja HANYA di sini. Jangan commit (agent yang commit). Jangan `pkill`/`killall`.
Mockup sudah disetujui founder (11 Nov). Baca HANYA mockup layar kartu-mu (html + PNG desktop dan ponsel). Aturan UI: `~/.agents/team/ui-standard.md` (bagian "Aturan yang bisa diperiksa"). Ikuti pola, token, dan komponen shadcn yang sudah ada di `apps/web/src/components` dan fitur tetangga. Copy bahasa Indonesia sesuai mockup.
Semua data lewat lapisan `api.ts` + `queries.ts` + `mock.ts` fitur (mock runtime `apps/web/src/lib/mock/runtime.ts`); komponen tidak tahu datanya mock.
Tiap layar: normal, loading (skeleton), kosong, error (dengan coba lagi), validasi, sukses; desktop 1280 dan ponsel 390, tanpa scroll horizontal di 320.
Dilarang: migrasi DB, logika uang di apps/api, berkas fitur kartu lain. Endpoint API baru hanya bila kartu memintanya; ragu: tulis di laporan, jangan buat.
Perintah berat lewat `heavy` dan HANYA oleh test-runner (satu token heavy). Implementer TIDAK menjalankan tsc/vitest/playwright/build; cukup baca ulang kodenya. Lint satu berkas boleh: `pnpm exec eslint <berkas>` dan `pnpm exec prettier --write <berkas berubah>`.
Laporan akhir (maks 15 baris): berkas berubah, keadaan yang dibangun, testid/label penting untuk test, selisih dari mockup dan alasannya, hal ragu.

Test: unit pakai `node:test` di `tests/legend-<kartu>-*.test.mjs` (pola: `tests/legend-wbwl-facility-admin-mock.test.mjs`, impor TS langsung + `dispatchMock`/`resetMocks`). E2E mock di `e2e/legend-<kartu>.mock.spec.ts` (pola `e2e/legend-1j7-print.mock.spec.ts`, config `playwright.mock.config.ts`, port `LEGEND_MOCK_PORT=3247`). Test-writer yang menulis test; implementer menyesuaikan nama ekspor sesuai "Kontrak" di bawah.

## wwyyk — tombol klaim bagian split (ponsel saja)

Mockup: `design/mockups/split-claim-wwyyk.html` + `split-claim-wwyyk-*-mobile.png` (siap, sedang-klaim, berhasil, sudah-diklaim, belum-bayar, kedaluwarsa, error).
Hook `useSplitClaim` sudah ada di `apps/web/src/features/ws03-qr-order/hooks.ts` (rahasia `ps_` di sessionStorage, `session-store.ts`). Bangun komponen tombol/kartu klaim bagian di layar split pelanggan yang sudah ada, dan tambah handler mock `POST /api/table-sessions/:sessionId/splits/:splitId/claim` di `ws03-qr-order/mock.ts` (atau `mock-engine.ts`) sesuai kontrak di `packages/shared` (cari skema claim split).
Kontrak: handler mock sukses 200 dengan bagian ter-klaim; klaim kedua bagian sama → 409 (sudah diklaim); split kedaluwarsa → 410/422 sesuai kontrak shared. Tidak ada pihak bisa klaim bagian yang sudah diklaim orang lain (jangan sampai bayar ganda).

## wpqs — sumber legal entity payroll (kebijakan pertama + jadwal THR)

Mockup: `design/mockups/hris/payroll-wpqs.html` + PNG `payroll-wpqs-*` (kebijakan, kosong, memuat, entitas-kosong, entitas-gagal, validasi, simpan-gagal, sukses, thr-baru, thr-kosong, thr-validasi, thr-simpan-gagal, thr-sukses).
Berkas: `apps/web/src/features/ws10-payroll-config/components/policies-tab.tsx`, `thr-tab.tsx`, + api/queries/mock fitur itu. Sekarang legal entity diambil dari policy pertama, jadi tenant baru tidak bisa membuat policy/THR pertama. Ambil daftar legal entity dari kontrak org/accounting yang sudah ada (cari endpoint legal entities di `packages/shared` dan fitur web lain yang sudah memakainya). HANYA UI pemilih sumber legal entity; jangan ubah hitungan payroll.
Kontrak: fungsi/hook daftar legal entity untuk payroll; entitas kosong → pesan + tautan ke pengaturan entitas; gagal muat → error + coba lagi; field legal entity wajib (validasi).

## rp3fk — kunci toggle email kategori security

Mockup: `design/mockups/platform/notification-preferences-rp3fk.html` + PNG `notification-preferences-rp3fk-*` (normal, loading, empty, error, validation, save-error, success).
Berkas: `apps/web/src/features/ws05-notifications/components/preferences-panel.tsx` (+ mock/api/hooks fitur). Kategori dengan `isEmailMandatory` (security): toggle email terkunci menyala, disabled dengan alasan terlihat (bukan hanya warna; ikon gembok + teks), tidak bisa dimatikan lewat keyboard, dan payload simpan tidak pernah mengirim email=false untuk kategori itu; mock menolak (422) bila dicoba.

## ijv8 — sarapan dari tiket (alur Z) + pengingat 5 menit

Mockup: `design/mockups/pos/pos-extra-ijv8-sarapan.html` + PNG `pos-extra-ijv8-sarapan-*-1280.png` dan `-390.png` (normal, loading, empty, error, validation, success, reminder).
Berkas: `apps/web/src/features/facility/` (`components/ticket-screen.tsx`, `api.ts`, `mock.ts`, `flow.ts`). Tambah bagian "pesan sarapan" di halaman tiket: pilih menu, pilih meja atau ambil sendiri, pesanan ditahan sampai `slot.endsAt − fireOffsetMinutes`, dan pengingat in-app 5 menit sebelum sesi habis. Web push = WS-06, JANGAN dibangun; cukup in-app. Backend order dari tiket fasilitas belum ada: buat fungsi api bertipe + handler mock saja (mis. `POST /api/facility/tickets/:ticketId/breakfast-orders`, `GET` daftar menu), ditandai TODO kontrak di laporan. Jangan ubah `packages/shared` skema yang sudah dipakai API; tipe baru taruh di fitur web dulu.
Kontrak: fungsi murni `breakfastFireAt(slotEndsAt, fireOffsetMinutes)` di `features/facility/flow.ts` (kembalian ISO string), validasi: minimal 1 item dan pilihan meja/ambil wajib.

## wjz1 — polish cetak label prep

Mockup: `design/mockups/pos/pos-extra-wjz1-label-prep.html` + PNG `pos-extra-wjz1-label-prep-*-1280.png` dan `-390.png` (normal, loading, kosong, error, validasi, sukses).
Berkas: `apps/web/src/features/operations-food-safety/components/label-prep-screen.tsx` (+ `logic.ts`). Perbaiki: CSS cetak tanpa halaman kosong (tidak ada `page-break-after` di elemen terakhir, tinggi tidak melebihi halaman), baris terpilih punya garis kiri (bukan hanya warna latar), teks rentang suhu negatif terbaca.
Kontrak: fungsi murni `formatTempRange(min, max)` di `operations-food-safety/logic.ts`: `(-22,-16)` → `"−22 s.d. −16 °C"` (tanda minus U+2212), `(0,4)` → `"0 s.d. 4 °C"`, `(-2,4)` → `"−2 s.d. 4 °C"`. Bila mockup memakai format lain, ikuti mockup dan laporkan.
