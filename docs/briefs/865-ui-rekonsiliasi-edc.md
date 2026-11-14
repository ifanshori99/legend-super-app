# 865 UI layar rekonsiliasi EDC (ui-engineer, mockup disetujui founder Q5)

Kartu legend-khi8n (bd show, termasuk komentar 830). Mockup disetujui: cabang design/edc-reconciliation (ff210f9a9) — baca berkas mockupnya, satu layar per kali.
Cabang ui/edc-rekonsiliasi-865 dari milestone/m1 (rantai EDC fix/edc-so-829 sudah masuk 64g). Langkah 0: pastikan route POST /edc/transactions/:id/reconciliation ada di m1 (`git grep`); tidak ada: lapor CTO.
Isi: daftar transaksi kartu yang ditandai + baris unknown tanpa flag (setelah 10 menit sejak sale dikirim), bukti, konfirmasi declined/approved dengan MFA Owner/FM, tombol terkunci selama sale_wire_open_at terisi. Akses: hanya Owner/Finance Manager (roleHasPermission di beforeLoad + guard API yang ada).
Ikuti ~/.agents/team/ui-standard.md. Teks UI daftarkan di katalog (tests/text-contract.test.mjs). Cek 390 px dan 1280 px lewat heavy --browser.
Paralel: Explore API EDC, test-writer (Playwright mock + vitest web), implementer per bagian layar. Review: ui-auditor + satu reviewer sonnet (architect high bila menyentuh guard API).
Pra-gate AGENTS.md (typecheck web lewat heavy). Commit + push tanpa force. Lapor sha, screenshot path, test, angka subagent.
