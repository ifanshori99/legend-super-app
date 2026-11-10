# Brief: engineer — sisa refund intent: payout guard GL, capture QRIS, ulang parkir SALE_MISSING

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/refund-payout-followups` dari `ws/refund-intent-guard` 27ba1fb9 (belum di m1; dibangun di atasnya), worktree `.worktrees/refund-payout-followups`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan (tiga kartu, tingkat K, kerjakan paralel lewat subagent; file tidak bertumpuk)
1. `legend-hxpd5` (P1): `intentBackedAt` di `accounting-auto-journal-guards.ts` tidak mengurangi bagian gateway yang diretur refund POS, jadi payout intent yang kini diizinkan parkir `POSTING_AMOUNTS_MISMATCH`. Pakai atribusi per metode yang sama dengan `posSaleInUseOfIntent` (`payment-admin.service.ts`); satu sumber kebenaran, jangan salin rumus.
2. `legend-r5brx` (P2): `handlePosPaymentPaid` (`pos-order-payment.ts`) menangkap tender QRIS tanpa mengunci `payment_intents` dan tanpa membaca refund yang sudah disetujui. Kunci intent dengan urutan `lockIntentsForFact` (jangan membuat deadlock baru dengan jalur refund), tolak capture (void tender + jalur refund yang ada) bila refund sudah memakai uangnya.
3. `legend-3bsyh` (P2): baris parkir `AUTO_JOURNAL_SALE_MISSING` (void dan `order.refunded`) tidak pernah diulang setelah penjualan terposting. Saat `aj:sale:X` terposting, set baris dependen ke retryable dengan `nextRetryAt = now`; tambah langkah runbook untuk penjualan yang diposting manual.
Detail: `bd show <id>`. Konteks cabang dasar: `git log fee69d45..27ba1fb9` dan `docs/briefs/179-refund-intent-guard.md`.

## Kartu
`ghostex board associate` ketiganya, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `accounting-auto-journal-guards.ts`, consumer/sweep auto-journal, `pos-order-payment.ts` (jalur capture), helper atribusi di modul refund/`payment-admin.service.ts`, runbook auto-journal, test. Jangan: `pos-shift.service.ts`, `tax.service.ts`, payroll, open bill, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu untuk tiap kartu (contoh hxpd5: terima 100k, jual QRIS 100k, refund POS 30k, payout 30k harus posted). Race capture vs approval refund dua urutan (cek `pg_locks`). `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob, laporkan jumlah file jalan. `node --test tests/*.test.mjs` bila tipe shared berubah. tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel; temuan nyata dibetulkan dan perbaikan terakhir dibaca ulang reviewer segar. Brief Codex `docs/briefs/181b-second-opinion-refund-payout-followups.md` di folder utama (tidak di-commit).

## Laporan
Sekali setelah ketiganya selesai: hasil, bukti, file berubah, SHA, urutan kunci akhir, migrasi (nomor + `when`), risiko tersisa. Jangan menunggu proses global (`pgrep vitest` milik agent lain); `heavy` mengatur antrean. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
