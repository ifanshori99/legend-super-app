# 1267 Bagian B (founder 25 Nov: "kerjakan sesuai rekomendasi kamu")

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-1267`, cabang `ws/1267-design-b` dari milestone/m1 9fcac9be1. Aturan umum sama dengan brief 1265. UI ikut `~/.agents/team/ui-standard.md` dan `DESIGN.md`. Teks UI baru masuk katalog teks.

## 16: pemilih QRIS/EDC saat menagih tukar menu (legend-t93l8, uang)

API `collectCharge` sudah menerima tunai/QRIS/EDC (legend-khvqb, af6845a55); UI baru tunai. Bangun pemilih metode di dialog tagih tukar menu dengan memakai ulang pola dan komponen pembayaran POS yang sudah disetujui (mockup `design/mockups/pos/payment.html`, `edc.html`; komponen kasir yang ada). Mockup kecil statis satu berkas di `design/mockups/pos/` dulu, lalu UI.
- QRIS: QR + sisa waktu + polling; kedaluwarsa, gagal, buat ulang. EDC: pilih transaksi EDC sah dari server, jangan ketik nominal sendiri. Status unknown/menunggu: tidak boleh ganti metode atau tagih ulang sampai server menyatakan aman.
- Nominal selalu dari server. Klik ganda, dua tab, refresh di tengah, kembali dari jaringan putus: tidak boleh bayar dobel atau tukar menu selesai tanpa bayar. Kunci idempotensi tetap sama untuk percobaan ulang.
- Bila API kurang (mis. daftar transaksi EDC atau status), jangan karang: pilih aturan paling membatasi dan laporkan. Perubahan backend hanya bila perlu, kecil, dan dengan test gagal dulu.
- Bukti: test unit/komponen untuk jalur di atas (gagal dulu), screenshot 390 dan 1280 ke `docs/review/img/1267-tukar-*.png` (browser lewat `heavy --browser`), prettier, eslint, text-contract, tsc web (+api bila disentuh).

## 15: audit layar fasilitas, pembayaran, Wi-Fi, HRIS (legend-5c0a)

Audit baca saja terhadap DESIGN.md v2; temuan nyata (bukan selera) diberi berkas:baris, dampak, perbaikan. Lalu diperbaiki di gelombang kedua. Keadaan kosong, galat, memuat, 390/1280, kontras, fokus, target sentuh 44px, teks Indonesia.

## 17 dan 18: katalog laporan; dialog koreksi PTKP, batal persetujuan bagi hasil, banner payout beku

Audit baca saja: katalog 105 laporan jujur ("Segera hadir" hanya untuk yang belum tersambung, tidak ada angka palsu, tautan mati), dan ketiga UI no. 18 aman (alasan wajib, konfirmasi jelas, tidak bisa dua klik, izin benar, banner terlihat di 390). Rekomendasi CTO: terima bila tidak ada temuan berat.

## Gelombang 2: perbaikan temuan audit (berkas di apps/web/src/features)

- F1 (`ws11-reports/lib.ts:41-46`, `catalog-page.tsx:38-40`, `facility-report/lib.ts:11-24`, `facility-report-hub.tsx`): "Segera hadir" diturunkan dari satu sumber kebenaran ketersediaan sumber data (server `metricSourceOf`, sumber `unavailable/source_not_built`). Utamakan lewat respons API yang ada; bila tidak ada, daftar bersama di `packages/shared` dengan test yang gagal bila menyimpang dari server. Cakup wifi, subscriptions, fnb_conversion, cleaning_time, product_revenue, menu.sold_out, payments.edc_settlement, operations.failed_items/devices/occupancy. Pastikan juga `gateway_settlement` (`metrics-gl-sources.ts` vs `payments-tax`): mana yang menang.
- F2 (`report-viewer-page.tsx:405`, `report-viewer.ts:93`): pakai `result.availability`; sumber belum dibangun = "Sumber data belum tersambung", bukan "coba lagi setelah ada transaksi".
- F3 (`ws10-employee-master/components/ptkp-correction-dialog.tsx:154`, `:238-245`): tanggal yang dilihat HR harus sama dengan yang disimpan. Baca `hris-employee-ptkp.service.ts` dulu. Jangan ubah semantik pajak di API; samakan label dengan perilaku server. Bila semantik server sendiri diragukan, laporkan.
- F4 (`ws10-payroll-payout/components/freeze-banner.tsx:193`): dialog buka-beku tidak bisa ditutup saat pending (Esc, klik luar, X), pola `ptkp-correction-dialog.tsx:60-76`.
- F5 (`ws10-payroll-payout/api.ts:337`): pastikan server menolak buka-beku kedua; buktikan dengan test yang ada atau baru. Kunci idempotensi ditambah hanya bila server menerimanya.
- Bukti: test gagal dulu, prettier, eslint, text-contract, tsc paket tersentuh. Jangan sentuh berkas butir 16.
- F6 (uang): `ws10-payslip/components/kasbon-page.tsx:243`, `reimbursement-page.tsx:229`: kunci idempotensi dipakai ulang sampai isi berubah (pola `ws05-payment-admin/use-attempt-key.ts`). Test: putus jaringan lalu kirim ulang = kunci sama.
- F7 (uang): satu pembungkus dialog bersama yang menolak tutup saat pending (Esc, klik luar, X) dan kunci percobaan tidak hilang saat dibuka lagi. Pasang di: `ws10-roster` (`roster-page.tsx:316-322`, `publish-dialog.tsx:42`), `ws05-payment-admin` (`refunds-panel.tsx:263`, `:410`, `refund-followup-dialog.tsx:158`, `:638`, `reconciliation-panel.tsx:374`, `edc-panel.tsx:450`, `unallocated-panel.tsx:221`), `ws10-payroll-payout` freeze-banner (F4), `facility-admin` `{products,addons,subscriptions,areas}-tab.tsx`. Test komponen untuk pembungkus + minimal refund, kasbon, terbit jadwal.
- F8: target sentuh 44px: `ws10-roster/week-grid.tsx:132`; varian `link` di mobile untuk `wa-reset/{waiting,blocked}`, `pin-locked`, `payslip-history`, `payslip-detail`, `pin-change`, `my-requests-page`. Jangan ubah varian `link` global bila memengaruhi teks inline.
- F9: teks keras ke katalog: `hris-requests/queue-decision-form.tsx:34-35`, `hris-owner-support/owner-request-card.tsx:78`.
- F10: "Tolak akses" di `owner-request-card.tsx:~125` pakai konfirmasi singkat.
