# 1227 Merge train batch103 status (20 Nov)

Cabang: `int/batch103` (base `int/batch102`).

## Gabung
- `ws/1223-ptkp-tax-year` (6d791b9ff): merge c22524520. Migrasi renumber 0515 -> 0519 (`ptkp_tax_year_history`, when 1795158400000) dan 0516 -> 0520 (`ptkp_history_correction`, when 1795158500000) lewat `scripts/migration-renumber.mjs`; journal dan snapshot dibangun ulang, `db:generate` "no schema changes".
- Referensi diperbarui: komentar 0520, `backfill-ptkp-history.ts`, `hris-ptkp-history.custom.sql`, `hris-employee-ptkp.service.ts`, `payroll-ptkp-backfill.ts`, test 1223, `docs/deployment.md`.
- Konflik: hanya berkas generated (`0515/0516_snapshot.json`, `_journal.json`), dibangun ulang oleh skrip. Tidak ada hunk kode, reviewer tidak dipakai.

## Gate (bukan full run)
- `check-migration-redefinitions.mjs --base int/batch102`: ok (2 migrasi baru), exit 0.
- prettier --check berkas berubah: lulus.
- `heavy pnpm run lint`: 0 error (2 warning lama di ws07-profit-share).
- `heavy pnpm run typecheck`: 3/3 sukses.
- `node --test tests/text-contract.test.mjs tests/migration-fk-inline.test.mjs`: 17 lulus.
- Vitest terarah (payroll-ptkp-tax-year-1223, payroll-coretax-a1-export, payroll-coretax-a1-format, payroll-run-lock, payroll-run-lock-rapel): 5 berkas, 67 tes lulus.
