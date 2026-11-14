# 851 Reset PIN slip via WhatsApp: alasan 409 dan hitung mundur 429 (engineer Sonnet, tingkat K akses)

Kartu: legend-bzw5k. Detail lengkap: `bd show legend-bzw5k`. Prasyarat ws/9h2oj-wa-reset dan ws/ur82k-lupa-pin-ui sudah di milestone/m1.

- Langkah 0: `git log --all --oneline --grep=legend-bzw5k`; bila sudah dikerjakan, berhenti dan lapor.
- API: 409 PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE membawa details [{field:'whatsapp', message:'identity_missing'|'identity_too_new'}]; 429 membawa retryAfterSeconds di body. Jangan bocorkan apakah nomor milik orang lain atau data pribadi lain.
- UI: pisahkan layar 'belum ada WA' vs 'nomor < 3 hari', sambungkan hitung mundur di blocked.tsx; ikuti mockup yang dirujuk kartu (design/mockups/payslip-pin bila ada). Teks di katalog.
- Paralel: Explore, test-writer gagal-dulu (API + komponen), implementer API dan implementer UI terpisah.
- Jangan sentuh payroll-run, HRIS leave, cash-out.
- Tanpa migrasi.
- Review: satu subagent architect effort xhigh (akses).
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.
