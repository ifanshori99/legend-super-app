# 847 Pesan bentrok WhatsApp dan header kasir aktif (engineer Codex)

Kartu: legend-5tewu (UI pesan bentrok nomor WhatsApp di pengaturan integrasi; kontrak legend-mbd2: 409 WHATSAPP_NUMBER_TAKEN, 422 VALIDATION_ERROR), legend-15ha6 (web klien kirim header kasir aktif ke rute floor/tables/table-links/table-sessions/kitchen; perluas POS_PATH di acting-staff.ts).
Detail: grep id di .beads/issues.jsonl. Jangan menjalankan bd.

- Langkah 0: `git log --all --oneline --grep=<id>`; bila sudah dikerjakan, berhenti dan lapor cabangnya.
- Tingkat S, frontend. Satu subagent per kartu, file terpisah.
- 15ha6 hanya sisi klien; jangan ubah penegakan server (itu legend-f586w).
- Teks UI baru didaftarkan ke katalog (tests/text-contract.test.mjs).
- Tanpa migrasi. Test gagal-dulu. Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.
