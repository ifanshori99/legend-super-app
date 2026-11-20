# 1205 Dua P2 pra-rilis (20 Nov)

Base: `int/batch99` (tip c17d7ff16). Tiap kartu worktree sendiri:
`command git worktree add "../legend-<kartu>" -b ws/<kartu> int/batch99`, lalu di worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Path berspasi: kutip. Pakai `command git`.

## A. legend-3tyl1 refund echo (uang, aturan jangan rugi)
`apps/api/src/services/payment-webhook.service.ts:~1718`. Konteks: `docs/qa/second-opinion-refund-hold-1200.md` P3-1. Echo refund dari dashboard provider dilewati dengan membandingkan jumlah intent; pelanggan overpay -> bagian lebih diabaikan tanpa hold -> Legend bisa refund lagi = bayar dua kali. Perbaikan: bandingkan dengan jumlah yang benar-benar ditagih provider; selisih yang tidak cocok = hold (bukan skip diam). Bila ragu: pilih aturan yang membatasi pembayaran.
Test fail-first: overpay + refund dashboard penuh -> tidak ada refund kedua, hold tercatat.

## B. legend-94xqo satukan env storage
`core-storage-runtime.ts` pakai `STORAGE_S3_*`; `profit-share-statement-ports.ts` + `apps/api/src/config/env.ts` pakai `OBJECT_STORAGE_*`. Jadikan satu set kanonik `STORAGE_S3_*`; `OBJECT_STORAGE_*` hanya fallback lama (deprecated, warning sekali). Validasi di `config/env.ts`, cek di `pnpm run doctor`, update `.env.example`, `docs/deployment.md`, `docs/release/production-credentials-checklist.md` (cukup satu set). Jangan baca `.env*` selain `.env.example`.
Test: hanya STORAGE_S3_* -> keduanya jalan; hanya OBJECT_STORAGE_* -> fallback jalan + warning; konflik nilai -> gagal start dengan pesan jelas.

## Bukti selesai (keduanya)
Test terarah: `LEGEND_TEST_FILES="..." heavy pnpm test`. `heavy pnpm --filter @starter/api typecheck`. prettier --check + eslint berkas berubah. Commit per langkah (akhir pesan `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), push. Lapor SHA, jumlah test, yang belum terverifikasi.
