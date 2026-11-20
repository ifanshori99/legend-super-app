# 1236 Status merge train batch105 (20 Nov)

Base int/batch104 (64f002066). Cabang int/batch105.

## Merge
1. ws/1232-neg-stock-reval -> 0910ce277. Konflik hanya `apps/api/drizzle/meta/_journal.json` (0521 vs 0522): dua entri disimpan berurutan. Snapshot 0522 basi (prevId = id 0520): dibangun ulang 3-arah (0521 + delta unique constraint 0522, perubahan terpisah), prevId = id 0521. SQL tidak diubah.
2. ws/1234-refund-room -> 5f9b364b7. Bersih, tanpa migrasi.

3. int/batch104 (e6e01f51f) -> 2a9d4c7b2, lalu (cb2fe4b1a) -> 11f1cb625. Bersih (scripts/test.mjs, tests/test-runner-selection.test.mjs).

## Gate
- check-migration-redefinitions --base int/batch104: ok (1 migrasi baru).
- tests/migration-fk-inline.test.mjs: 5/5. `pnpm db:generate`: No schema changes.
- prettier berkas berubah: bersih. lint: 0 error (2 warning lama di apps/web ws07-profit-share, tidak disentuh).
- typecheck: 3/3 sukses (web dari cache).
- `tests/text-contract.test.mjs tests/*-contract.test.mjs`: 874/874. `tests/test-runner-selection.test.mjs`: 22/22 (dijalankan setelah merge cb2fe4b1a).
- Area (affected-tests --max 120 + data-import-registry.test.ts): 121 berkas, 2642 lulus, 1 skip. Dijalankan di 2a9d4c7b2; merge cb2fe4b1a sesudahnya hanya mengubah satu berkas tes root.
- Registry data-import: 0522 hanya DROP/ADD CONSTRAINT, tanpa pernyataan data, jadi tanpa entri baru; tes hijau.
- Catatan: affected-tests memotong 1407 jadi 120 berkas. Full run oleh CTO.
