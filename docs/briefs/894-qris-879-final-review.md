# 894 Review akhir area QRIS hold (cabang fix/qris-hold-so-879, c2902fa4e)

Read-only. Tingkat K uang. Repo `/Users/ifanshori99/Projects/legend super app/legend`; baca lewat `git show`/`git diff` atau worktree sendiri dari `origin/fix/qris-hold-so-879`. Jangan checkout di folder utama.

## Konteks
Laporan sebelumnya: `docs/qa/second-opinion-qris-hold.md`, `docs/qa/second-opinion-qris-879.md` (di cabang qa masing-masing atau m1), brief 879, 885, 889. Aturan desain: satu kode bayar per tagihan; waktu lokal bukan bukti kode mati; hanya jawaban final penyedia (`provider_final_at`, predikat `providerAnswerFinal`) yang mematikan kode; dana salah bayar/terlambat ke `payment_unallocated_funds`; dana terparkir terbuka memblokir split, bayar seluruh order, dan release QR (409 `FUNDS_UNRESOLVED`); founder Q93 force release QR oleh manager tanpa bukti penyedia masuk antrean rekonsiliasi; founder Q7 kartu menang, QR di-refund bila balapan.

## Fokus
1. Berkas produksi yang belum pernah direview architect: `apps/api/src/worker-main.ts`, `worker/notification-adapters.ts`, `packages/shared/src/pos/*`, `services/payment/refund-events.ts`, `services/payment-webhook.service.ts` (semua jalur, bukan hanya Duitku).
2. Perbaikan terakhir 889 (diff `606feb8a6..c2902fa4e`): poll urutan pending vs expired, budget per provider+kind, `FUNDS_UNRESOLVED` di split/bayar seluruh/release, `providerAnswerFinal` di empat jalur, `cancelSupersededAtGateway`.
3. Cari: tamu bisa membayar lebih dari tagihan atau dua kali; kode dianggap mati tanpa jawaban final; dana masuk tanpa tercatat atau tercatat dua kali; webhook/poll ganda; lock order dan balapan paralel; tenant bocor.

## Hasil
P0-P3, berkas:baris, skenario gagal konkret, usul test. Ringkas.
