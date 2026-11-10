# Brief 101: fix temuan Codex DOIT R5b (P1, tingkat K, uang)

## Temuan Codex second opinion (brief 62, run G1s5q, rentang `5c04f1b2..13425b65`)

`apps/api/src/services/payment-webhook.service.ts:813`, tingkat P1.

Retry menggabungkan identitas integrasi dari row lama dengan payload baru. Jalur serangannya:
1. Integrasi B mengetahui eventId milik integrasi A yang berstatus `received` atau `failed`, beserta reference atau providerRef-nya.
2. Integrasi B mengirim payload `paid` yang ditandatangani dengan kuncinya sendiri.
3. Payload itu bisa melunasi intent milik outlet A di tenant yang sama.

Arah fix:
- Retry memproses payload yang tersimpan, bukan payload pengganti.
- Integrasi penanda tangan wajib cocok dengan integrasi di row sebelum payload pengganti diterima. Bila tidak cocok: tolak dan catat audit.
- Mulai dari test merah yang mereproduksi serangan lintas integrasi.

## Aturan
- Basis: worktree `.worktrees/fix-doit-webhook`, cabang `ws/fix-doit-webhook` dari `milestone/m1` terbaru. DOIT sudah ada di m1 lewat merge `13425b65`.
- Periksa jalur webhook lain (EDC, refund callback) untuk pola yang sama. Catat sebagai bead; perbaiki bila kecil.
- Review: reviewer Opus dan architect.
- Gate sekali lewat `heavy`.
- Commit lokal, lalu handoff ke merge train.
