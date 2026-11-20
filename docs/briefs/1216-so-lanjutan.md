# 1216 Second opinion lanjutan (sisa "Belum diperiksa" SO 1208), 20 Nov

Kode: worktree `/Users/ifanshori99/Projects/legend super app/legend-int-batch101` (int/batch101 = m1 + batch98-101 + 1214). READ-ONLY: jangan edit, jangan jalankan test (full run sedang jalan). `command git`. Path berisi spasi: kutip.

Prinsip founder: "jangan sampai rugi". Cari bug yang membuat pihak dibayar lebih, outlet rugi, data bocor, atau angka laporan salah. Tingkat P0-P3. Hanya temuan nyata dengan skenario konkret (input/state -> hasil salah), file:baris, usulan singkat. Maks 45 tool call; di ~35 tulis laporan. Format:

```
Verdict: LOLOS | TIDAK
## Pn judul
file:baris. Skenario. Usulan.
Belum diperiksa: ...
```

Konteks SO sebelumnya: `docs/qa/second-opinion-*-1208.md` di checkout utama `/Users/ifanshori99/Projects/legend super app/legend`.

## Area
- F. Akuntansi lanjutan: HPP saat avg cost 0 (resep/stok tanpa biaya), buka ulang periode sesudah distribusi bagi hasil dibayar (apakah angka berubah tanpa koreksi distribusi), pembalikan jurnal.
- G. Payroll pajak dan akses: PPh21 (TER/tahunan, Desember), rapel/koreksi, matriks akses hris (siapa boleh lihat gaji siapa, antar outlet/entitas/tenant).
- H. CRM promo + refund: aritmetika refund untuk order dengan promo/voucher/poin (refund parsial, proporsi diskon, voucher kembali atau tidak, poin dibalik), double refund.
