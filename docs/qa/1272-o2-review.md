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

## Re-review 27 Nov (46904b51f): LULUS
- P1 hitung ulang pembulatan/service/pajak/total dari bekal, beda = `amount_mismatch` + alert (`pos-offline-batch.service.ts:497-544`).
- P2 #1 held dihitung ada di tiga cek celah (`pos-receipt.service.ts` ~2218, 2306, 2439).
- P2 #2 jurnal sale shift_closed debit 1205 (`accounting-auto-journal-amounts.ts:2842-2865`); 0536 memetakan entitas lama, gagal peta = jurnal diparkir. Kas buku sekali (test).
- P3 1-4 beres (0535 unik parsial, `paid_in_future`, 409 eventId dua kit, cetak ulang shift).
- P3 baru: void cloud atas sale shift_closed membalik ke 1205 padahal uang keluar dari laci buka. Keputusan CTO: void sale offline shift_closed ditolak; koreksi lewat refund back office (pola E6). Bead.
- P3 baru: 409 menggagalkan batch; O3 menyisihkan event 409 sebagai "perlu dicek".
