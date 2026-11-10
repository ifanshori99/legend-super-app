# 392 Pilot review buta: refund recovery pesanan

Peran: architect, review saja (baca ~/.agents/team/roles/architect.md bagian review). Tingkat K (uang).

## Tugas
Review perubahan untuk bug correctness, keamanan uang, dan edge case.

- Repo: `/Users/ifanshori99/Projects/legend super app/legend`
- Worktree terpisah, detached: `git worktree add --detach .worktrees/pilot-392-$RANDOM b78f169c` (tanpa `pnpm worktree:setup` kecuali perlu menjalankan test).
- Diff: `git diff b6a38096 b78f169c` (abaikan drizzle `meta/*.json` dan test). Berkas berisiko:
  - `apps/api/src/services/order-recovery-refund.ts`
  - `apps/api/src/services/order-recovery-refund-amount.ts`
  - `apps/api/src/services/accounting-auto-journal-recovery-refund.ts`
  - `apps/api/src/services/accounting-auto-journal-guards.ts`
  - `apps/api/src/services/payment-refund.service.ts`
- Invariant (PRD): refund tidak melebihi yang dibayar, parsial berulang tidak dobel; jurnal seimbang (penjualan, service, PBJT, kas/gateway) dan tidak dua kali; approval sesuai matriks, penyetuju beda dari pemohon; poin loyalty dan klaim dibatalkan sebanding; idempotensi webhook/refund gateway; isolasi tenant dan outlet.

## Aturan pilot (wajib)
- Buta: jangan baca commit sesudah b78f169c di cabang mana pun, komentar bd `legend-h1dyy` atau `legend-94q2l`, brief 372/375, `docs/PROGRESS.md`, atau laporan thread lain soal area ini.
- Kerjakan sendiri tanpa subagent.
- Hanya baca. Boleh test terarah atau script di scratchpad untuk membuktikan temuan. Jangan edit kode, commit, atau ubah bd.
- Batas: maksimal sekitar 25 pemanggilan tool. Tulis laporan sebelum batas itu.
- Catat jam mulai dan selesai (`date +%H:%M`). Selesai: `git worktree remove --force <path>`.

## Laporan
1. Jam mulai, jam selesai.
2. Temuan urut paling berat: severity (HIGH/MEDIUM/LOW), `file:line`, skenario konkret (urutan kejadian -> hasil salah vs benar), seberapa yakin.
3. Hal yang diperiksa dan aman.
