# Sub-brief 785 putaran perbaikan

Konteks: `docs/briefs/sub-785-invoice-entry.md`. Commit dasar `a1d60b9b0`. Jangan commit, jangan jalankan tsc/build/e2e.

## Konvensi angka (keputusan agent, berlaku qty DAN harga DAN pajak)

Format Indonesia: titik = pemisah ribuan, koma = desimal. `"1.000"` = 1000 di qty dan harga. `"12,125"` = 12,125. `"1,500"` = 1,5 (desimal, sesuai id-ID). Teks dengan titik yang tidak berpola ribuan (mis. `"12.5"`) ditolak dengan pesan cara memperbaiki. Nilai default dari PO ditulis dengan koma desimal dan titik ribuan (round-trip ke nilai yang sama). Pajak tetap rupiah bulat.

## M (implementer model) `apps/web/src/features/ws06-purchasing/invoice-entry-model.ts`

- Satu parser untuk qty dan harga mengikuti konvensi di atas; default `goodsDraftsFromOrder` memakai formatter yang sama (tidak ada lagi `plainDecimal` dengan titik desimal).
- Ekspor formatter harga desimal untuk dipakai F dan P (mis. `formatIdrDecimalText(decimal4)` → `"Rp 12.500,5"`, sesuai DESIGN.md minus `−`), atau pakai yang ada di `@starter/shared/core` bila sudah ada.

## T (test-writer) `tests/supplier-invoice-entry.test.mjs` dan `e2e/legend-0xnm.mock.spec.ts`

- Unit: default harga PO `12.1250`, `185000`, `12500.5` re-parse ke nilai sama; qty `"1.000"` = 1000; harga `"1.000"` = 1000; `"12.5"` ditolak.
- E2E: test kedua panggil `choosePurchaseOrder`; `choosePurchaseOrder` jangan klik trigger ulang di dalam `toPass` bila listbox sudah terbuka.

## F (implementer form) `apps/web/src/features/ws06-purchasing/components/invoice-form-page.tsx` + `packages/shared/src/i18n/messages/ws06-invoice-entry.ts`

Dari audit UI: harga PO pakai formatter M; fokus ke field error pertama saat submit; setelah sukses fokus ke heading pratinjau (atau live region polite); ganti PO saat baris sudah diedit dan hapus baris jasa: konfirmasi (dialog yang ada di `@/components/ui`) atau toast undo; state terpisah bila outlet belum dipilih; bar ringkasan sticky pakai `env(safe-area-inset-bottom)` + `scroll-padding-bottom`; baris checkbox `min-h-11` dan seluruh baris jadi label; satu hitungan baris (yang disertakan) di badge dan ringkasan; error dan sukses dengan ikon + teks; atribut `name` pada input; satuan (uom) tampil di samping input qty; validasi saat blur per field. Dari reviewer: `VALIDATION_ERROR` tampilkan pesan/field detail dari API (`ApiError`), pesan pajak hanya bila field-nya ppnIdr/pph23Idr. Hint qty dan harga menjelaskan konvensi angka.

## P (implementer pratinjau) `apps/web/src/features/ws06-purchasing/components/invoice-match-preview.tsx` + `packages/shared/src/i18n/messages/ws06-invoice-match-preview.ts`

Harga satuan pakai formatter desimal M (jangan `Money` yang membulatkan); selisih bp ditampilkan sebagai persen (bp/100, format id-ID, mis. `+1,5%`); ikon + teks pada status error/sukses; cek layout 320 px (tanpa scroll horizontal).

## Putaran 3 (reviewer 2) `invoice-form-page.tsx` + katalog `ws06-invoice-entry.ts`

1. Error pajak dari API datang sebagai `HttpError(422, VALIDATION_ERROR, msg)` tanpa `details` (`apps/api/src/services/purchasing-invoice.service.ts:238,1231-1237`). Kenali pesan PPN/PPh 23 itu (cocokkan teks pesan server) dan tampilkan `serverRejectedTax` (Bahasa Indonesia) + tandai field PPN/PPh 23; jangan tampilkan pesan Inggris mentah.
2. Detail `lines.N.field` dipetakan ke "Baris N+1: <label field>" dan error dipasang ke input baris itu bila ada; pesan server Inggris tidak ditampilkan mentah (pakai teks katalog per field).
3. Mengubah `invoiceDate` juga menghapus error `dueDate` `dueBeforeInvoice` (validasi ulang pasangan tanggal).

## Putaran 3b: route (e2e 5/5 gagal)

Akar: `kelola.pengadaan_.faktur.baru.tsx` bersarang di `kelola.pengadaan_.faktur.tsx` yang tidak punya `<Outlet>`, jadi /kelola/pengadaan/faktur/baru merender daftar. Agent sudah `git mv` ke `kelola.pengadaan_.faktur_.baru.tsx` dan path `createFileRoute("/_kelola/kelola/pengadaan_/faktur_/baru")`.

- R (implementer): regenerasi `apps/web/src/routeTree.gen.ts` dengan generator resmi (`@tanstack/router-generator@1.167.40` di `node_modules/.pnpm`, config dari `apps/web/vite.config.*`), jangan tulis tangan. Pastikan `<Link to="/kelola/pengadaan/faktur/baru">` di `invoice-page.tsx:871` cocok tipe route. Jangan jalankan tsc/e2e.
- F3 (implementer): butir 1-3 Putaran 3 di atas. Logika pemetaan error API ditaruh sebagai fungsi murni di `invoice-entry-model.ts` (mis. `invoiceApiErrorView(code, message, details)`), form hanya memakai hasilnya.
- T3 (test-writer): unit di `tests/supplier-invoice-entry.test.mjs` untuk fungsi pemetaan F3 (pesan PPN/PPh 23 server tanpa details → tax view; `lines.2.quantity` → baris 3). Gagal-dulu sebelum F3 selesai.
