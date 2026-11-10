# Brief 150: second-opinion — EDC PAN scrub (legend-5gub)

## Peran
Second opinion Codex, tingkat K (data kartu, migrasi yang mengubah data). Baca `~/.agents/team/roles/second-opinion.md`. Read-only; laporkan temuan dengan file:line dan skenario gagal.

## Rentang diff
Repo `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/edc-pan-scrub` (worktree `.worktrees/edc-pan-scrub`).
`git diff 3143577d..d25cf41b` (commit 867d0059, d25cf41b) — satu run, sekitar 240 baris non-test (tanpa snapshot drizzle).

## Berkas berisiko
- `apps/api/drizzle/0113_edc_pan_scrub.sql` — migrasi data (UPDATE edc_transactions, lift/restore FORCE RLS, lock_timeout).
- `apps/api/drizzle/meta/_journal.json`, `apps/api/drizzle/meta/0113_snapshot.json` — urutan migrasi (nomor diregenerasi di merge train).
- `packages/shared/src/edc/index.ts` — `edcTransactionSchema` read path: `message` kini disamarkan.
- `docs/runbooks/edc-pan-scrub.md` — query deteksi dan cara deploy di luar jam operasional (cloud dan edge).
- Test: `apps/api/src/test/edc-pan-scrub-migration.test.ts`, `edc-pan-logs.test.ts`, `edc-card-data.test.ts`.

## Invariant
1. Setelah migrasi, tidak ada nomor kartu penuh (PAN, 12–19 digit, boleh dipisah spasi/strip) tersimpan di `edc_transactions` (card_type, rrn, invoice_no, batch_no, dispatch_batch_no, message, masked_pan), dengan ambang sama seperti filter tulis di `packages/shared/src/edc`.
2. Baris bersih tidak berubah sama sekali. Jumlah (`amount_idr`), status, `completed_at`, `updated_at`, tenant dan outlet tidak berubah di baris mana pun.
3. Idempoten: run kedua tidak mengubah baris.
4. RLS: FORCE RLS kembali aktif di transaksi yang sama; policy tidak diubah; tidak ada data tenant lain yang terbaca atau tertulis di luar UPDATE ini.
5. Batas varchar dan CHECK constraint tetap terpenuhi; `masked_pan` hasil samaran lolos aturan first-6/last-4.
6. Data kartu tidak pernah masuk log di jalur EDC (`apps/api/src/edge/edc/*`, POS EDC tender/standalone, error handler).
7. Migrasi aman dijalankan migrator drizzle (satu transaksi untuk semua migrasi pending) di cloud dan di tiap node edge.

## Yang diminta
Cari bug nyata terhadap invariant di atas: regex PostgreSQL vs JS, kasus tepi panjang/ pemisah, kolom terlewat, efek lock, perilaku saat role migrasi bukan owner atau tanpa BYPASSRLS, dan celah test (test yang lulus padahal invariant dilanggar).
