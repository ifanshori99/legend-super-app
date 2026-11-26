# Merge ws/1272-o1 ke int/rc2 (renumber migrasi)

Worktree `../legend-1272-o1`, merge `--no-commit` origin/ws/1272-o1 di atas origin/int/rc2 (9d1300298+C3a 527994433) sudah berjalan, konflik terbuka.

1. Kode: `apps/api/src/routes/pos-shift.routes.ts` (ambil dua import), `apps/api/src/services/pos-shift-print.ts`: int/rc2 sudah memindah isi laporan ke `buildShiftReportData` (P3 cetak). Terapkan perubahan O2 (penjualan dari `shiftCapturedTenders`, sale offline shift_closed dikecualikan, review O2 P3 4) DI DALAM `buildShiftReportData`, jangan hidupkan kode lama. Cek GET print shift (P3) juga memakai sumber yang sama.
2. Migrasi: int/rc2 punya 0533_tablet_print_marks. O1 0533-0536 jadi 0534-0537 (urutan sama): rename SQL + snapshot, journal int/rc2 + 4 entri idx 534-537, tag baru. Snapshot O1 ditambah tabel `tablet_print_marks` dari snapshot 0533 int/rc2; `prevId` snapshot pertama O1 = id snapshot 0533 int/rc2. Isi SQL tidak berubah kecuali komentar nomor.
3. Rujukan: `pos-offline-kit.test.ts` (0533_pos_offline_kits), `data-import-registry.test.ts` (0536_offline_cash_clearing_mapping), komentar nomor di SQL.
4. Bukti: `pnpm exec drizzle-kit generate` di apps/api kosong; typecheck api+web lewat heavy; `LEGEND_TEST_FILES="src/test/pos-offline-batch.test.ts src/test/pos-offline-kit.test.ts src/test/pos-shift-print-928.test.ts src/test/data-import-registry.test.ts" heavy pnpm test` dari ROOT worktree.
5. Commit merge "Merge ws/1272-o1: offline kit and offline-batch ingest (migrations renumbered 0534-0537)" + Co-Authored-By, push `HEAD:refs/heads/int/rc2` hanya bila `merge-base --is-ancestor origin/int/rc2 HEAD`.
