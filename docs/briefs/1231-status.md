# 1231 status: merge train batch104 (20 Nov)

Cabang `int/batch104` (base `int/batch103`). Digabung `--no-ff`: ws/1229-tax-export-superseded (32c16cfe7), ws/1228-ui-fix-dialogs (c86d052f1).

- Konflik `_journal.json` (0519/0520 vs 0521): trivial, kedua entri dipertahankan. Tanpa reviewer.
- Snapshot 0521 salah rantai (parent = 0518, bentrok dengan 0519). Dibuat ulang dengan `db:generate` di atas 0520; SQL 0521 identik dengan sumber. `db:generate` kini "No schema changes".
- Gate: check-migration-redefinitions exit 0; prettier lolos; lint 0 error (2 warning lama); typecheck lolos (3/3); text-contract + migration-fk-inline 17/17; 4 test payroll 61/61.
- Catatan: idx jurnal memang punya celah (monoton, unik), bukan akibat merge ini.
