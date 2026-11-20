# 1208 Second opinion per area, pra-rilis (20 Nov)

Kode: worktree `/Users/ifanshori99/Projects/legend super app/legend-int-batch100` (int/batch100 = m1 + batch98/99/100, kode hampir final). Path berisi spasi: kutip. READ-ONLY: jangan edit, jangan jalankan test (full run sedang jalan di worktree itu). `git` lewat `command git`.

Prinsip founder: "jangan sampai rugi". Cari bug yang membuat pihak dibayar lebih, outlet rugi, data tenant bocor, atau angka laporan salah. Gaya: tingkat P0 (uang/data hilang pasti), P1 (mungkin rugi/bocor), P2 (rugi kecil/kondisi jarang), P3 (rapikan).

Batas: maks 45 tool call. Pada ~35 call: berhenti eksplorasi, tulis laporan. Laporan = jawaban akhirmu (CTO yang menyimpan ke `docs/qa/second-opinion-<area>-1208.md`). Format:

```
Verdict: LOLOS | TIDAK (ada P0/P1/P2 uang)
## Pn judul
file:baris. Skenario konkret (input/state -> hasil salah). Usulan perbaikan singkat.
Belum diperiksa: ...
```

Hanya temuan nyata dengan skenario konkret. Tidak ada nit gaya.

## Area

- A. Edge 1199 P2 fix: commit `4c98259a6` + `78e2ffb47` (diff dari `3f094d767`). Plus yang belum diperiksa SO 1199: freshness `apps/api/src/edge/runtime.ts` + penutupan override sesudah rewind, `catalog-gate.ts`, urutan link event sesudah restore. Konteks: `docs/qa/second-opinion-edge-catalog-1199.md`.
- B. HRIS + payroll: SO terakhir 14-15 Nov (`docs/qa/second-opinion-hris.md`, `second-opinion-hris-payroll-15nov.md`, `second-opinion-payroll-955.md`). Periksa apakah temuan lama sudah tertutup, lalu cari yang baru: hitung gaji, potongan, lembur, slip, akses data karyawan antar outlet/tenant.
- C. Akuntansi + HPP: SO terakhir 15 Nov (`second-opinion-keuangan-hpp-15nov.md`). Jurnal seimbang, HPP dari resep/stok, periode tutup buku, laporan laba rugi.
- D. CRM + loyalty: belum pernah SO. Poin (earn/redeem/expire/refund), voucher, member, batas redeem, double spend offline.
- E. Inventori + stok: belum pernah SO khusus. Pergerakan stok, opname, transfer antar outlet, resep konsumsi, stok negatif, retur.
