# Brief lanjutan G4ncv: 0141 jangan hapus kode respons sah (legend-ymhh)

## Cabang
Lanjut di `ws/edc-pan-fix` (worktree `.worktrees/edc-pan-fix`, HEAD 36599100, belum masuk m1, migrasi belum rilis). Jangan push, jangan merge.

## Masalah
Codex 150b (`docs/briefs/150b-second-opinion-edc-pan-fix.result.md` di folder utama): `0141_edc_pan_scrub_separators.sql:81` mengubah `Kartu [disamarkan] - 51` jadi `Kartu [disamarkan]`. `51` kode respons sah. Melanggar invariant "baris bersih tidak berubah". Fixture `edc-pan-scrub-migration.test.ts:372` tidak menutup kasus ini.

## Tujuan
Batasi pemulihan sisa 0135 pada baris yang asal-usulnya terbukti (pola sisa yang hanya bisa lahir dari 0135), sehingga baris bersih dengan kode respons setelah marker tidak berubah. SQL, JS, dan query deteksi tetap konsisten. Perbarui runbook bila efek yang diakui di baris 37-41 hilang.

## Kartu
`ghostex board associate legend-ymhh`, `bd update legend-ymhh --status in_progress`; saat lapor `--status review` + `bd comment`.

## Bukti selesai
Fixture regresi gagal dulu: `Kartu [disamarkan] - 51`, `Kartu [disamarkan] 05`, dan sisa 0135 asli tetap dibersihkan. `LEGEND_TEST_FILES` daftar eksplisit `src/test/edc-pan*.test.ts` lewat `bash -c` + nullglob, laporkan jumlah file jalan. tsc api lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel. Tambah bagian run baru di `docs/briefs/150b-second-opinion-edc-pan-fix.md` (hanya diff baru).

## Laporan
Hasil, bukti, file berubah, SHA, risiko.
