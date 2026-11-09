# Brief 100: fix temuan Codex di journals (P2, tingkat K)

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`.

## Temuan Codex second opinion (brief 70, run G73zo)
`apps/api/src/services/accounting-journal-manual.service.ts:718` dan `apps/api/src/services/accounting-journal-recurring.service.ts:428`. Tingkat P2.

Expiry lokal bisa menolak approval yang sah:
1. Transaksi inbox mulai sebelum deadline, tetapi belum commit.
2. Settlement berjalan setelah deadline, membaca `pending`, lalu menyimpan `rejected`.
3. Inbox kemudian commit `approved`.
4. Consumer mengabaikan jurnal tersebut, sehingga posting hilang.

Arah fix: tunggu outcome terminal dari layanan approval, atau jalankan expiry chain secara atomik (row lock atau status bersyarat di layanan approval). Reproduksi dulu dengan test race. Pola serupa di refund dan procurement approval boleh dijadikan acuan.

## Aturan
- Basis: worktree `.worktrees/fix-journals-expiry`, cabang `ws/fix-journals-expiry` dari `milestone/m1` terbaru.
- Cek juga consumer approval lain (refund, procurement, PO) untuk race yang sama. Catat temuan sebagai bead; perbaiki bila kecil.
- Review: reviewer Opus dan architect (uang). Gate sekali lewat `heavy`. Commit lokal, lalu handoff ke merge train.
- Laporan mengikuti template.
