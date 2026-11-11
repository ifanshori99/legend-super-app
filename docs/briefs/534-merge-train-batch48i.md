# 534 Merge train batch48i (7 cabang)
Peran: engineer sebagai merge train (~/.agents/team/roles/engineer.md; aturan merge train di ~/.agents/team/TEAM.md "Hemat waktu dan token"). Sonnet. Isi cabang sudah direview; jangan review ulang.
Target: milestone/m1 (sekarang 7917440a). Buat cabang integrasi sendiri `int/batch48i` dari origin/milestone/m1 di worktree `.worktrees/int-batch48i` (`git worktree add`, jangan pakai --worktree ghostex).
Urutan merge (`git merge --no-ff`), sesuai nomor migrasi:
1. ws/test-infra-flakes e796420a
2. ws/dd0g-coverage-gate 5e1f281f (tanpa migrasi; konflik pnpm-lock.yaml: regenerasi dengan pnpm install --lockfile-only)
3. ws/hris-manager-backfill 8492f846
4. ws/breakfast-pay c7a57878
5. ws/ws01-identity 38aa8604 (0331)
6. ws/ws05-pay-admin 5cb6daf1 (0328, 0340-0341)
7. ws/pos-refund-ceilings ffb47d9a (0328 bersama ws05-pay-admin)
Konflik yang diketahui: `apps/api/src/services/payment-refund-approval-limits.ts` antara 6 dan 7. Ambil versi ws05-pay-admin (intentKeys/relatedIntents), lalu port dari pos-refund-ceilings: CTE `voided_cash`, klausa `paidCapScope`, `notBillTenderRefund`, `nativeOrderUuid` -> rujuk `order_id IN (SELECT ref FROM intent_keys WHERE kind='order')`; kunci grup `order:<id>` dipertahankan. Setelah port: test terarah kedua cabang (pos-void-refund-ceilings, payment-refund-role-limits, payment-refund-system-chain, payment-refund-approval-limits*) jalan sendiri-sendiri (dua file terakhir flaky bila paralel satu tenant).
Journal drizzle: `idx` dan `when` harus urut naik; selesaikan bentrok teks, jangan ubah isi migrasi.
Gate: per cabang eslint+prettier atas berkas berubah sebelum merge; di akhir satu `heavy pnpm check` (LEGEND_COVERAGE=1 sesuai gate baru). Gagal: bisect, bagi ke implementer. Flaky yang diketahui (jangan blokir bila lulus saat diulang sendiri): pos-qris-capture-refund-race C2a, http.test, menu-print-db.test, ai-gateway.test AIG-01 (00:00 s/d batas hari bisnis).
Selesai: fast-forward milestone/m1 ke int/batch48i dan push origin milestone/m1 (bukan main). Update docs/PROGRESS.md. Hapus worktree cabang yang sudah digabung dan bersih. Laporan: hash m1 baru, hasil pnpm check, konflik yang diselesaikan, angka subagent.
