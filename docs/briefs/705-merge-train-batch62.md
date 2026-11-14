# Brief: merge train batch62

Lanjutan batch61 (sudah di `milestone/m1` 70f90cecd). Ikuti `~/.agents/team/roles/` merge train seperti batch61. Maks 7 cabang. Jangan merge ke `main`, jangan deploy.

## Cabang (urut)
1. `ws/payroll-payout-so-fixes` (fad22fed5, menggantikan `ws/finance-exceptions`), lebih dulu gabungkan `fix/edge-migration-rls` 46698834a ke dalamnya. Ikuti `docs/briefs/700-batch62-edge-migration-merge.md`: pertahankan 0348/0349 dari batch61, hapus 0534/0536 + entri journal, nomori ulang sisanya berurutan setelah 0349, `when` tetap. Wajib: `edge-received-events-migration.test.ts` hijau.
2. `ws/platform-pos-security-small`
3. `ws/reports-ops-backend`
4. `ws/suite-flakes`
5. `ws/loyalty-points-money`
6. `ws/reports-dashboard-fixes`
7. `ws/hris-leave-flakes`

`ws/edge-sync-resilience` (0538/0539 dari brief 700) tidak ada di batch ini; worktree lokalnya terhapus oleh pembersihan disk, cabang remote utuh. Catat saja untuk batch berikut.

## Wajib
- `node ~/.agents/team/check-journal.mjs origin/milestone/m1` dan snapshot drizzle berantai (perhatikan snapshot 0550), `db:generate` kosong.
- e2e `auth.spec` postLoginPath hijau.
- Satu run penuh bersih di tip akhir bila memungkinkan (guard kill massal sudah terpasang, penyebab SIGTERM 07:07 sudah ditutup). Bila mati lagi, catat jam tepat dan isi `~/.claude/state/heavy-log.csv`, jangan ulang lebih dari sekali.
- Tutup bila terbukti: legend-gnm6y, legend-9uks, legend-u7ozi, legend-60psh, legend-y9uop.
- Akhir gelombang: `python3 ~/.claude/scripts/session-usage.py <session-uuid>` dan `~/.claude/scripts/parallel-report <repo> --since <HH:MM>`, catat di `docs/PROGRESS.md` (batch61 belum tercatat, sekalian).
- Flake `legend-odyct` (backfill replay vs teardown, FORCE RLS): boleh dibetulkan di batch ini bila kecil (serial + `finally`), dengan review sonnet.
