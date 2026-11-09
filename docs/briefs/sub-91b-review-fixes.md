# Sub-brief 91b: perbaikan temuan review (e2e-az)

Konteks: `docs/briefs/sub-91-e2e-az.md`. Edit HANYA berkas grup kamu. Jangan commit. Setelah edit: `npx eslint <berkas>` bersih, `npx prettier --write <berkas>`, lalu satu run `LEGEND_TEST_FILES="src/test/e2e-az/<berkas>" heavy pnpm test 2>&1 | tail -40` (grup 4: spec Playwright cukup typecheck). Laporan ≤ 150 kata: lulus/gagal/skip, gagal baru yang nyata (baris PRD, hasil, file:line).

Aturan umum: setiap penolakan diasersi dengan status tunggal + kode galat spesifik (bukan `>=400`, bukan `[409,422]`, bukan `.rejects.toThrow()` tanpa kode). Tanggal bisnis: hitung di zona Asia/Jakarta (`new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta"}).format(d)`), bukan `toISOString()` UTC.

## Grup 1: az-h-reservation.test.ts

- :709-723 RSV-03 batal ganda: asersi 409 + kode, hitung baris refund untuk `paid.id` sama dengan setelah batal pertama.
- :577-591 RSV-02: pastikan satu perilaku replay (200 idempoten ATAU 409) sesuai kode, ganti judul "tamu lain".
- lint: `outletA` tak dipakai (:68).

## Grup 2: az-j-opname-journal.test.ts + az-k-payroll-leave.test.ts

- j :685 tolak hitungan sendiri: kirim kode `STOCK_COUNT_SELF_APPROVAL`; :256-262 `expectRefused` wajibkan `code` di semua pemanggil.
- j :65 `businessDate: today` → tanggal Jakarta.
- k :527 overlap: satu status + kode overlap. :532 `backwards` + kode. :829-843 403 HR-03 + kode.
- k :565-573 HR-01 peek: bila 200, asersi `data` kosong/terfilter secara eksplisit (bukan `.every` di array kosong).
- k :588-589, :690, :973 `today/tomorrow` → tanggal Jakarta.
- lint: `secondOutlet` tak dipakai (k :45).

## Grup 3: az-d-kds.test.ts

- :925, :1026, :1324 `toBe(400)` tanpa kode: tambah kode; :1324 KDS-07 ubah hanya `employeeId` dari payload valid.
- :1351 KDS-05 `after >= before` → `>` atau nilai konkret.
- :849-863 KDS-01 judul: sebut "API" bukan render layar.
- lint di berkas ini (lihat `npx eslint`), termasuk `no-explicit-any` (ganti dengan tipe sempit / `unknown`).

## Grup 4: az-r-whitelabel.test.ts + e2e/az-whitelabel.spec.ts

- r :347 TS2307 `../../services/pos-receipt.service` tak ada di m1: impor dinamis lewat variabel string (`const mod = "../../services/pos-receipt.service.ts"; await import(/* @vite-ignore */ mod)`) agar typecheck m1 lulus.
- r :250-262 menu kosong: pilih satu status yang benar per kode (cek route), jangan terima 200|404.
- spec :44-47, :63-68 `surface()`: tunggu `networkidle` + elemen akar, asersi teks halaman tidak kosong sebelum memindai.
- spec :97-104 (skip legend-ozud): hapus guard `404 → return`; manifest wajib ada dan bermerek tenant.
- lint di dua berkas ini.
