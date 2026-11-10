# Brief: perbaikan temuan Codex 422 (refund recovery), kartu legend-pbwzq

Untuk thread G2i7n (cabang `ws/pti5r-promo-refund`, tip 095b4099). Keputusan CTO: betulkan semua.

1. P1 `apps/api/src/services/order-recovery-refund.ts:392` — replay hanya untuk order dengan promo aktif; tanpa promo, refund Rp3 gagal final bisa diajukan ulang Rp4 setelah pembulatan pajak berubah. Replay jumlah dan split semula untuk SEMUA order.
2. P1 `:392` — tanpa promo, refund `rejected` bisa diajukan lagi lewat laporan baru. Tangani penolakan sebelumnya eksplisit untuk semua order (`nothing_left`).
3. P1 `:766` — pendahulu replay dipilih berdasar waktu pembuatan issue; B terbuka sebelum A, A gagal final, B selesai -> A tak ditemukan. Pilih pendahulu berdasar urutan penyelesaian/filing yang sudah diproses.
4. P2 `apps/api/scripts/recovery-refund-final-failure-check.sql:8` — FORCE RLS tetap berlaku untuk pemilik tabel; wajibkan peran BYPASSRLS atau iterasi per tenant, gagal eksplisit bila akses kurang.
5. P2 `docs/runbooks/recovery-refund-final-failure-backfill.md:80` — helper menulis audit baru tiap panggilan; dedupe audit, uji pemanggilan berulang.

Bukti: test gagal-dulu per temuan (order tanpa promo, rejected, urutan B-sebelum-A, panggilan helper dua kali), lalu lulus bersama 8 file test terarah. tsc + eslint via `heavy`. Satu subagent architect xhigh atas diff. Push, kartu `legend-pbwzq` ke review, lapor.
