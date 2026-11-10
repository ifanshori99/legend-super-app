# 387 Pilot review buta: kedaluwarsa poin loyalty (FIFO)

Peran: architect, review saja (baca ~/.agents/team/roles/architect.md bagian review). Tingkat K (uang/poin).

## Tugas
Review perubahan satu commit untuk bug correctness, keamanan data poin, dan edge case.

- Repo: `/Users/ifanshori99/Projects/legend super app/legend`
- Buat worktree terpisah, detached: `git worktree add --detach .worktrees/pilot-387-$RANDOM 8f0b4630` (tanpa `pnpm worktree:setup` kecuali kamu butuh menjalankan test).
- Diff yang direview: `git diff 8f0b4630^ 8f0b4630` (berkas `apps/api/src/services/loyalty-expiry.service.ts` dan `apps/api/src/test/crm-expiry.test.ts`).
- Konteks fitur: poin member punya grant dengan `expires_at`; redeem, restore, reverse (refund), expire, dan adjust manual dicatat di ledger berurutan `posting_seq`. Tujuan commit: redeem tidak boleh dipindah ke grant yang diposting sesudahnya, dan grant yang jatuh tempo lebih awal hangus dengan jumlah benar.

## Aturan pilot (wajib)
- Buta: jangan baca commit lain di cabang `ws/w5by9-expiry-fifo` atau sesudah 8f0b4630, jangan baca komentar bd `legend-w5by9`, `docs/PROGRESS.md`, atau laporan thread lain soal kartu ini.
- Kerjakan sendiri tanpa subagent supaya biaya bisa dibandingkan.
- Hanya baca. Boleh menjalankan test terarah atau script coba di scratchpad untuk membuktikan temuan. Jangan edit kode, jangan commit, jangan ubah bd.
- Catat jam mulai dan jam selesai (`date +%H:%M`).
- Selesai: hapus worktree pilot (`git worktree remove --force <path>`).

## Laporan
1. Jam mulai, jam selesai.
2. Daftar temuan, urut paling berat: severity (HIGH/MEDIUM/LOW), `file:line`, skenario konkret (urutan ledger -> hasil salah vs hasil benar), seberapa yakin (terbukti test/script atau dari baca kode).
3. Hal yang kamu periksa dan nyatakan aman.
