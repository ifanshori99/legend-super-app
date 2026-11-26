# Review K D2 laporan keuangan F6 (ws/1272-d2 b9d6b927b)

Reviewer: architect (Opus), 27 Nov. Baca kode saja. Hasil: **LULUS**, 0 P1, 1 P2, 3 P3.

## Aman
- Exclusion EBITDA mencakup akun terpetakan + sub-akun, dilewati sebelum term lain menghitungnya: tidak dobel/hilang. Laba bersih tidak berubah. `ms-finance.test.ts` mencocokkan tiap angka ke `journal_lines` dan snapshot bulan tertutup.
- EBITDA sesuai keputusan 1; peran tak terpetakan = catatan "Belum memisahkan", tidak menebak.
- legal_entity tersaring tenant; pemanggil lingkup outlet hanya membaca outletnya. Kas/bank menolak split outlet (`dimension_not_supported`).
- Izin laporan tidak berubah. Keluarga lain hanya terpengaruh bila term bertanda `exclude`.
- 3 test tim lain yang diubah sah. Tanpa migrasi (`account_mappings.role` varchar).

## Temuan
- P2 `apps/web/src/features/ws11-reports/lib.ts`: web belum menampilkan `availability.note`. Masuk kartu D5 (legend-x73li).
- P3 `metrics-query.service.ts:514`: catatan muncul untuk entitas tanpa jurnal; dengan split entitas catatan global.
- P3 `ms-finance.test.ts`: belum ada test tenant kedua.
- P3 `coa.ts:629,666`: akun 6113/8103/8104 hanya untuk entitas baru; tenant lama memetakan sendiri (sesuai keputusan 1).

## Keputusan CTO
- Gabung sesudah gate (ms-finance + 3 test diubah + typecheck api/web lewat heavy). P2 masuk D5. P3 test tenant kedua dikerjakan di D5 juga.
