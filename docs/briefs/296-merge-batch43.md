# Merge train batch43 (CTO 10 Nov)

Dasar: ref `milestone/m1` dc345b64 (worktree milestone-m1 sudah tidak ada: buat `integ/m1-batch43` + worktree `.worktrees/integ-b43` dari ref itu).

Urutan merge (`git merge --no-ff`), semua tip sudah dicek CTO:
1. `ws/audit-retention-purge` cdb624b9 — 0187, when 1794266000000
2. `ws/ai-provider-tenant` 97d02ab6 — 0188, when 1794267000000
3. `ws/doit-pending-poller` 895e4312 — 0190, when 1794269000000
4. `ws/cash-bank-recon` afd6cab3 — 0191, when 1794270000000
5. `ws/equipment-maintenance` f9afff77 — 0198, when 1794277000000
6. `ws/table-link` 1ead4c4d — 0200, when 1794279000000 (memuat 685n 6ef7034d)
7. `ws/ws11-f5-posting-seq` 6353e2f8 — tanpa migrasi
8. `ws/training-orders-followup` ffe54e37 — tanpa migrasi
9. `ws/notification-outbox-events` 56b8c157 — tanpa migrasi
10. `docs/arch-member-loyalty` b07b1032 — dokumen saja

Migrasi: `when` naik ketat sesuai urutan di atas; `idx` berurutan di jurnal; rantai ulang `prevId` tiap migrasi ke snapshot migrasi sebelumnya (sekarang hampir semua menunjuk 0186). Nomor berkas boleh tetap (lubang 0189, 0192-0197, 0199 boleh). Sesudah tiap merge bermigrasi: `pnpm db:generate` harus kosong. Konflik isi kode: kembalikan ke CTO, jangan diselesaikan dengan menebak.

Gate sekali di akhir lewat `heavy`: typecheck, `pnpm test` penuh, e2e. Flaky `platform-org-api` TEN-06 Q39 (409 buat outlet): bila muncul lagi, ulang file itu sendiri dan catat; kartu terpisah sudah dibuat.

Sesudah m1 maju: catatan rilis di m1, `docs/PROGRESS.md`, lalu hapus worktree yang cabangnya sudah di m1 dan bersih (`git worktree remove`, tanpa --force; `git worktree prune`). Jangan sentuh worktree yang sedang dipakai: `hr-scheduling`, `small-293`, `split-bill`, `ws08-111j`.

Laporan sekali di akhir: SHA m1 baru, urutan dan `when`/prevId tiap migrasi, hasil gate (angka), konflik, worktree yang dihapus, ruang disk.
