# 150b — Second opinion EDC PAN scrub fix

Rentang: `a8c90378..36599100`, cabang `ws/edc-pan-fix`, worktree `.worktrees/edc-pan-fix`. Snapshot 0141 diabaikan. Audit read-only; hanya laporan ini ditulis. Hasil: **1 P2 terhadap invariant tertulis; tidak ditemukan P1 baru**.

- `apps/api/drizzle/0141_edc_pan_scrub_separators.sql:81` — **P2: cleanup menghapus angka sah pada baris yang sudah bersih (invariant 2).** Sanitizer pada `a8c90378` mengubah jawaban `Kartu 4111111111111111 - 51` menjadi `Kartu [disamarkan] - 51`: tidak ada PAN lagi, dan `51` adalah kode respons sah. 0135 membiarkannya; 0141 memilihnya melalui predikat marker pada baris 96 lalu menghapus `51`. Reproduksi PostgreSQL 17 memakai ekspresi CASE/regexp persis dari migrasi menghasilkan `Kartu [disamarkan]`, dengan predikat PAN `false` dan predikat cleanup `true`; schema JS sekarang tetap mempertahankan message bersih tersebut. Efek ini memang sudah diakui runbook baris 37–41, tetapi bertentangan dengan invariant “baris bersih tidak berubah”. Test lolos karena fixture bersih pada `apps/api/src/test/edc-pan-scrub-migration.test.ts:372` menyisipkan kata `kode` antara marker dan `51`, sehingga tidak menguji kasus ini. Saran: batasi pemulihan sisa 0135 pada baris yang asal-usulnya dapat dibuktikan; bila penghapusan angka sah memang diterima, nyatakan pengecualian invariant secara eksplisit dan tambahkan fixture regresi tersebut.

## Verifikasi

`LEGEND_TEST_FILES='src/test/edc-pan-scrub-migration.test.ts src/test/edc-pan-logs.test.ts src/test/edc-pan-patterns.test.ts' pnpm test` dijalankan pada worktree target dengan PostgreSQL disposable: **3 file, 41 test lulus, exit 0**. Termasuk kegagalan UPDATE di autocommit yang mempertahankan FORCE RLS, role owner NOSUPERUSER/NOBYPASSRLS, idempotensi, dan validasi `maskedPanSchema`. Log: `/tmp/legend-150b-edc-pan-tests.log`.

Tiga subagent audit berjalan paralel (puncak 3). Probe SELECT PostgreSQL memeriksa 7.776 kombinasi message; probe JS memeriksa 248.832 kombinasi cleanup serta 88 kombinasi panjang/pemisah pada schema asli. Tidak ditemukan celah baru pada tab/spasi/strip berulang, greedy matching, panjang mask, nominal bertitik, atau guard nomor order. Dukungan ARE untuk `(?:...)` dan escape dalam bracket juga dikonfirmasi pada [dokumentasi PostgreSQL 17](https://www.postgresql.org/docs/17/functions-matching.html#POSIX-SYNTAX-DETAILS).

## Batas pembuktian

Fixture utama menjalankan 0135 dan 0141 dalam transaksi terpisah (`apps/api/src/test/edc-pan-scrub-migration.test.ts:627`); belum ada reproduksi khusus dengan data kotor dalam satu transaksi batch migrator. Kode migrator dan blok DO diperiksa; tidak ditemukan skenario gagal konkret pada jalur batch atau pemulihan `lock_timeout`. Tidak mengakses data staging/pilot, mengubah kode, commit, push, atau merge.
