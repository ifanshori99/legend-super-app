# Review K O1+O2 offline (ws/1272-o1 b4541115a)

Reviewer: architect (Opus, xhigh), 27 Nov. Baca kode saja. Hasil: **GAGAL**, 1 P1, 2 P2, 4 P3. Re-review cukup diff perbaikan.

## Aman
- Tidak ada stok/kas dobel: satu eventId = satu order (PK `(tenant,event_id)`, kunci run, cek `order_exists`).
- Nomor L harus tepat high-water+1; celah ditolak + alert.
- Izin/tenant: perangkat bertanda tangan, outlet, kit, `shift.cash.operate`; edge ditolak. 0534 RLS tenant+outlet, append-only.

## P1
- `services/pos-offline-batch.service.ts:518-558`, `packages/shared/src/pos/offline-batch.ts:95`: `roundingIdr` tanpa batas; service charge dan pajak tidak dicocokkan ke `kit.snapshot.tax`. Potongan diam-diam lewat pembulatan negatif atau pajak 0. Fix: flag `amount_mismatch` (bukan tolak) bila pembulatan melebihi `billRounding` atau service/pajak beda dari hitungan snapshot. Test: pembulatan -50.000 masuk dengan flag + alert.

## P2
1. Sale `held` memakai nomor L tanpa baris `pos_receipts` (`:337-345`, `:363`) -> `receiptGapsForOutletFast` (`pos-receipt.service.ts:2162,2251`) memblok Tutup Hari. Fix: held `pos_offline_sales` dihitung sebagai nomor ada di kedua fungsi gap. Test: held lalu Tutup Hari lolos.
2. Shift tutup: tutup paksa menghitung tunai fisik jadi selisih lebih (`accounting-auto-journal-amounts.ts:3392-3424` debit kas) + jurnal penjualan debit kas = kas buku dobel.

## P3
1. `number_taken` tidak disimpan (`:316-331`): tablet kirim ulang selamanya. Simpan sebagai held dengan kunci lain.
2. `paidAt` masa depan -> tanggal bisnis besok (`:583`). Flag bila `paidAt > now`.
3. eventId sama di dua kit -> 23505 -> 500 (`:363`, `:226`). Jawab 409.
4. Cetak ulang shift tutup ikut menampilkan tunai ini (`pos-shift-print.ts:107-110`). Kecualikan.

## Keputusan CTO 27 Nov
- Sale masuk sesudah shift tutup tetap di-ingest (dinilai tepat). P2 #2: jurnal penjualan sale `shift_closed` mendebit akun penampung "kas offline belum dicocokkan", bukan kas laci. Finance mencocokkan penampung dengan selisih lebih shift. Alert supervisor menyebut shift, nomor L, dan nominal. Test: shift tutup paksa + sale terlambat = kas buku tidak dobel.
- P1, P2 #1, semua P3 dikerjakan sebelum gabung.
- Penolakan tutup shift saat antrean tablet belum kosong ditegakkan di tablet (O3) dan di server bila tablet melapor jumlah antrean (O3).
