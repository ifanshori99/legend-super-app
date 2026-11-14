# 846 Delivery: pesanan needs_review dan tombol layar (engineer Sonnet)

Kartu: legend-5d76 (petakan lini webhook yang belum cocok lalu inject ke KDS lewat injectDeliveryOrder, endpoint + UI), legend-c2m5c (layar delivery: tombol Kirim ulang + Tandai sudah ditangani, founder Q58; API legend-eyqvo sudah closed).

- Langkah 0: `git log --all --oneline --grep=<id>` dan cek komentar kartu. Bila sudah dikerjakan di cabang lain, berhenti dan lapor cabangnya.
- Paralel: Explore per kartu, test-writer gagal-dulu, satu implementer per kartu, file tidak bertumpuk.
- 5d76: hanya staf berizin outlet itu; total pesanan mengikuti harga platform, tidak ada pihak dibayar lebih; inject idempoten (klik ganda tidak membuat dua order).
- Teks UI baru didaftarkan ke katalog (tests/text-contract.test.mjs).
- Jangan sentuh EDC, cash-out, payroll.
- Migrasi: bila perlu pakai 0388.
- Review: satu subagent architect effort high.
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.
