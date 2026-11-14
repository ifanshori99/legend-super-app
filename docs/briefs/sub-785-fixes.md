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
