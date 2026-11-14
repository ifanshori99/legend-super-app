# 845 Finance view dan akses laporan (engineer Sonnet)

Kartu: legend-ftqf (satu tagihan tidak konsisten membuat seluruh daftar dana tak teralokasi 409), legend-5bjh (link laporan pemegang saham membuka /_kelola/reports/* yang butuh dashboard.management.view), legend-z13t (finance view: auto-journal AUTO_JOURNAL_RECEIPT_PENDING lebih dari 1 hari).

- Paralel: Explore per kartu, test-writer gagal-dulu, satu implementer per kartu.
- ftqf: baris bermasalah diberi status needs_review di DTO + UI, baris sehat tetap tampil. Tidak ada saldo atau dana berubah; test bukti tidak ada pihak dibayar lebih.
- 5bjh: akses pemegang saham hanya ke laporannya sendiri; jangan melonggarkan izin manajemen. Bila butuh izin baru, berhenti dan lapor.
- Jangan sentuh cash-out/drawer (thread 841), EDC, payroll.
- Migrasi: bila perlu pakai 0387.
- Review: satu subagent architect effort xhigh (uang dan akses).
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.
