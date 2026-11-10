# Brief 150b: second-opinion — EDC PAN scrub fix (legend-tjwb)

## Peran
Second opinion Codex, tingkat K (data kartu, migrasi yang mengubah data). Baca `~/.agents/team/roles/second-opinion.md`. Read-only; laporkan temuan dengan file:line dan skenario gagal.

## Rentang diff
Repo `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/edc-pan-fix` (worktree `.worktrees/edc-pan-fix`).
`git diff a8c90378..36599100` (cabang `ws/edc-pan-fix`, basis `milestone/m1` a8c90378, satu commit). Hanya diff perbaikan; abaikan `apps/api/drizzle/meta/0141_snapshot.json` (salinan snapshot 0140).

## Berkas berisiko
- `apps/api/drizzle/0141_edc_pan_scrub_separators.sql` — migrasi data baru, satu blok `DO` (lift FORCE RLS, UPDATE `edc_transactions`, restore FORCE, `lock_timeout` lokal).
- `apps/api/drizzle/meta/_journal.json` — entri 0141.
- `packages/shared/src/edc/index.ts` — `cardNumberLike` (message, tulis dan baca) dan `panLikeReference` (rrn/invoice/batch saat baca) memakai pola lebar; `panLengthDigits` (`hasPanLengthDigits`, guard tender POS di `apps/api/src/services/pos-edc-tender.ts`) sengaja tetap 13-19 digit beruntun supaya nomor order (`P261109-12345678`) tidak ditandai. 0141 juga melipat digit yang menempel ke `[disamarkan]` (sisa 0135).
- `docs/runbooks/edc-pan-scrub.md` — query deteksi dan eksekusi manual.
- Test: `apps/api/src/test/edc-pan-scrub-migration.test.ts`, `edc-pan-logs.test.ts`, `edc-pan-patterns.test.ts`.

## Konteks
- 0135 (`0135_edc_pan_scrub.sql`) sudah ada di `milestone/m1` dan mungkin sudah diterapkan di dev/staging; tidak diubah. 0141 mengulang scrub dengan pola lebar. DB baru menjalankan 0135 lalu 0141 dalam satu batch migrator.
- Pemisah yang diterima di antara digit: spasi, tab, strip, berulang atau campuran. Titik tidak.
- Ambang: 13+ digit di rrn, invoice_no, batch_no, dispatch_batch_no; 12+ di card_type, message, masked_pan.

## Invariant
1. Setelah migrasi, tidak ada PAN (12–19 digit dengan pemisah spasi/tab/strip berulang atau campuran) di tujuh kolom `edc_transactions`, dengan ambang per kolom di atas. Pola SQL migrasi, query deteksi runbook, dan pola JS sama.
2. Baris bersih tidak berubah. Kolom selain tujuh kolom scrub tidak berubah di baris mana pun.
3. Idempoten: run kedua 0141 tidak mengubah baris.
4. FORCE RLS tidak pernah tertinggal mati, termasuk saat file dijalankan autocommit dan gagal di tengah. Policy tidak diubah.
5. `masked_pan` hasil samaran lolos `maskedPanSchema`; batas varchar terpenuhi.
6. Jalur baca dan tulis JS tidak meloloskan PAN berpemisah ganda; tidak ada regresi pada nilai sah (RRN 12 digit, nomor order, nominal bertitik).
7. Runbook aman dijalankan manual (`psql -v ON_ERROR_STOP=1 --single-transaction`), deteksi menghitung seluruh tabel.

## Yang diminta
Cari bug nyata terhadap invariant di atas: beda semantik regex PostgreSQL ARE vs JS (`\t` di bracket, `(?:...)`, greedy), kasus tepi panjang/pemisah, interaksi 0135 lalu 0141, perilaku blok DO di dalam transaksi batch migrator dan di autocommit, `lock_timeout`, efek pelebaran `hasPanLengthDigits` pada `apps/api/src/services/pos-edc-tender.ts`, dan celah test (test yang lulus padahal invariant dilanggar). Tulis hasil ke `docs/briefs/150b-second-opinion-edc-pan-fix.result.md`.

## Run 2 (legend-ymhh, perbaikan temuan P2 run 1)

### Rentang diff
`git diff 36599100..6e31ce84` di cabang `ws/edc-pan-fix` (satu commit). Hanya diff baru; run 1 sudah diperiksa.

### Yang berubah
- `apps/api/drizzle/0141_edc_pan_scrub_separators.sql` — klausa `message` (CASE dan WHERE) dan header.
- `packages/shared/src/edc/index.ts` — `maskCardNumbers` (dipakai `safeMessage` jalur tulis dan `edcTransactionSchema.message` jalur baca).
- `docs/runbooks/edc-pan-scrub.md` — penjelasan aturan dan query deteksi `message`.
- Test: `edc-pan-scrub-migration.test.ts`, `edc-pan-patterns.test.ts`.

### Invariant
1. Baris bersih tidak berubah: `Kartu [disamarkan] - 51`, `Kartu [disamarkan] 05`, `[disamarkan] - 1111`, `4111 - [disamarkan]`, `[disamarkan] 12345` (satu spasi) tetap persis.
2. Sisa 0135 dilipat ke mask hanya bila disambung pemisah yang tidak bisa dilewati pola lama `[0-9]([ -]?[0-9]){11,}` (bukan tepat satu spasi atau satu strip) dan melebihi aturan struk 6 digit awal / 4 digit akhir (7+ sebelum mask, 5+ sesudah). Setelah migrasi, tidak ada digit kartu di luar 6 awal / 4 akhir yang tersisa dari PAN 12-19 digit.
3. SQL CASE, SQL WHERE, query deteksi runbook, dan JS `maskCardNumbers` memberi hasil sama; CASE tidak mengubah baris yang tidak dipilih WHERE.
4. Idempoten: run kedua 0141 dan `maskCardNumbers` dua kali tidak mengubah apa pun.
5. Efek yang diterima: angka sah 5+ digit sesudah / 7+ sebelum mask dengan pemisah ganda atau tab (mis. `[disamarkan] - 123456`) terhapus permanen; tercatat di runbook dan header SQL.

### Di luar rentang (sudah dicatat)
Sisa di pesan tepat 200 karakter yang terpotong oleh jalur tulis lama: bead `legend-lg45`.

### Yang diminta
Cari bug nyata terhadap invariant di atas, khususnya: sisa 0135 yang lolos aturan (termasuk dua mask dalam satu pesan), baris bersih realistis yang berubah, beda semantik ARE vs JS pada pola baru, dan test yang lulus padahal invariant dilanggar. Tulis hasil ke `docs/briefs/150b-second-opinion-edc-pan-fix.result.md` di bawah judul `## Run 2`.
