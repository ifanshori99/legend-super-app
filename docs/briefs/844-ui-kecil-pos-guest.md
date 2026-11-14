# 844 UI kecil POS dan tamu (engineer Codex)

Kartu: legend-sgvw0 (panel bagi tagihan dan dialog pindah item menampilkan lini void), legend-xz3ll (log remake/comp pakai orderLabel/itemName/nama staf; tab stasiun KDS pakai station-summary), legend-d6d1 (follow-up booking tamu: link DP mock 404, daftar zona publik, notify waitlist, menu manual-order >100).
Detail tiap kartu: grep id di .beads/issues.jsonl. Jangan menjalankan bd.

- Tingkat S, frontend. Tiap kartu satu subagent, file terpisah. d6d1 butir (2) dan (3): bila butuh endpoint baru atau keputusan produk, catat sebagai sisa, jangan desain sendiri.
- Jangan sentuh berkas EDC, pos-order-support.ts, edge, atau cash-out.
- Tanpa migrasi.
- Test komponen/e2e gagal-dulu untuk sgvw0 dan xz3ll. Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.
