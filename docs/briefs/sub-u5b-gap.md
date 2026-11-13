# U5b gap: 12 layar konfigurasi vs milestone/m1 (13 Nov 2026)

Sumber layar: `legend/design/mockups/review-q29.html` (Q29-Q40, disetujui founder). Basis cek: `origin/milestone/m1` 5cbe2a1e.
`origin/ws/ui-bo-config` (brief 505) sudah leluhur m1; `ws/ui-mixed-q36` juga sudah masuk.

| Q | Layar | Status | Bukti di m1 | Catatan |
|---|---|---|---|---|
| 29 | Aturan pajak (woc1) | Sudah | `features/ws05-tax/components/tax-rules-page.tsx`, `tax-rule-dialog.tsx`, `target-picker.tsx`; e2e `legend-woc1.mock.spec.ts` | Penyimpangan diterima: outlet terkunci saat ubah (kontrak update tanpa `outletId`, API pajak = uang, tidak disentuh); picker daftar centang |
| 30 | Peringatan pajak terakhir (d5pz) | Sudah | `tax-rule-dialog.tsx`, `ws05-tax/lib.ts` | Keputusan CTO: "Tetap nonaktifkan" = draf nonaktif |
| 31 | Jurnal manual outlet per baris (5ac3) | Sebagian, dibangun di cabang ini | `ws07-accounting/components/manual-journal-form-page.tsx` | Kurang: panel total + "Ajukan untuk persetujuan" (kartu `legend-ktpc0`). UI dengan mock; API approval belum ada |
| 32 | Stasiun item menu (0frf) | Sudah | `ws03-menu/components/station-routing-section.tsx` | - |
| 33 | Hub Pengaturan tenant (j0kd) | Sudah | `ws11-audit/components/settings-hub-page.tsx` | - |
| 34 | Klaim bagian split (wwyyk) | Sudah | `ws03-qr-order/components/bill/split-claim.tsx`; e2e `legend-wwyyk.mock.spec.ts` | Tukar token ke poin member (`legend-90na8`, BE poin) di luar mockup dan di luar batas (uang/poin) |
| 35 | Status edge back-office (s7szu) | Sebagian, dibangun di cabang ini | Alert hanya di POS `/operasional/koneksi` (`ws02-edge/components/receipt-run-alert.tsx`) | Kurang: layar back-office tabel node (kartu `legend-ph62j`). UI dengan mock; API cloud + nama node belum di kontrak |
| 36 | Payroll kebijakan pertama (wpqs) | Sudah | `ws10-payroll-config/components/legal-entity-field.tsx`, `policy-dialog.tsx` | - |
| 37 | Payroll jadwal THR (wpqs) | Sudah | `thr-tab.tsx`, `thr-dialog.tsx` | - |
| 38 | Preferensi notifikasi (rp3fk) | Sudah | `ws05-notifications/components/preferences-panel.tsx`, route `kelola.notifikasi.tsx` | - |
| 39 | Sarapan setelah shower (ijv8) | Sudah | `facility/components/breakfast-section.tsx` | - |
| 40 | Label prep (wjz1) | Sudah | `operations-food-safety/components/label-prep-screen.tsx` | - |

## Pekerjaan cabang `ui/tenant-config`

### S35: layar Status edge back-office (legend-ph62j, bagian UI)
- Mockup: `/Users/ifanshori99/Projects/legend super app/legend/design/mockups/backoffice/receipt-run-s7szu.html` + `receipt-run-s7szu-desktop.png`, `-mobile.png`.
- Pakai ulang `apps/web/src/features/ws02-edge/` (komponen `receipt-run-alert.tsx`, `mock.ts`, `api.ts`, `queries.ts`). Route baru di area `_kelola` (cek nav/breadcrumb mockup untuk path dan tempat menu).
- Data lewat fungsi api.ts bertipe; mode mock (`API_MOCK`) memakai fixture; di luar mock lempar `ApiError` `CONTRACT_PENDING` seperti `features/ws04-pos-order/api.ts`. Tipe DTO node di web (`types.ts`) + catatan `CONTRACT-GAPS.md` (API cloud daftar node + nama node).
- State: normal (dengan alert struk berulang), memuat, kosong, galat; desktop 1280 dan 390.

### S31: panel total + "Ajukan untuk persetujuan" jurnal manual (legend-ktpc0, bagian UI)
- Mockup: `.../backoffice/jurnal-outlet-5ac3.html` + PNG `jurnal-outlet-5ac3-*-desktop|mobile.png`.
- Ubah `apps/web/src/features/ws07-accounting/components/manual-journal-form-page.tsx` (dan file baru di folder itu). Jangan ubah nilai yang dikirim ke API yang ada atau logika hitung; panel total = tampilan (debit, kredit, selisih) dari baris form.
- "Ajukan untuk persetujuan": mutasi baru di api.ts, mock di mock.ts, di luar mock `CONTRACT_PENDING`; catat kontrak yang dibutuhkan di `CONTRACT-GAPS.md`. Bila API belum ada, jangan matikan alur "Simpan" yang sudah jalan.

## Aturan bersama
- Teks UI baru ke katalog `packages/shared/src/i18n/messages/` (berkas per fitur, pola `t("ns.key")`); cek `LEGEND_TEST_FILES="tests/text-contract.test.mjs" pnpm test`.
- UI ikut `~/.agents/team/ui-standard.md`; komponen dari `apps/web/src/components/ui`.
- Jangan sentuh `apps/api` uang/auth. Jangan jalankan tsc/e2e/build (token heavy dipegang agent). Boleh `npx eslint <file>` dan `npx prettier --check <file>`.
- Laporan: file berubah, state yang dibangun, penyimpangan dari mockup.

## Hasil (13 Nov 2026)

Dibangun: S35 `/kelola/status-edge` (ws02-edge), S31 panel total + "Ajukan untuk persetujuan" (ws07-accounting). Screenshot `design/screens/ui-u5b/` (1280/390, + gelap untuk 3 state), skrip `scripts/ui-check-u5b.mjs`.

Sengaja berbeda dari mockup:
- S35: ikon alert segitiga (set lucide); tanpa garis tepi kiri tebal (dilarang craft floor); badge status pil + ikon; tanpa daftar "Tinjau kondisi" (alat mockup) diganti `?demo=` di mode mock; menu hanya tampil di mode mock sampai API cloud daftar node ada (lihat `ws02-edge/CONTRACT-GAPS.md`).
- S31: sukses ajukan pindah ke halaman detail dengan banner hijau (jurnal yang sudah diajukan tidak bisa disunting di form); "Simpan draf" tetap ada; baris jurnal tetap tabel/kartu form lama (bukan blok "Baris N"); banner galat tanpa garis kiri merah muda (craft floor).
- S31 tambahan: tombol "Setujui dan bukukan" disembunyikan bagi pemohon (tampilan saja, API tetap menolak).
