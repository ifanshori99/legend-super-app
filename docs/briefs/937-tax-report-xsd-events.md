# 937 Laporan pajak: validasi XSD Coretax + event ekspor + i18n kode error (WS-07, kartu S)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort high. Tanpa ubah angka pajak/jurnal, tanpa akses, tanpa migrasi.
Cabang: worktree-mu dari `milestone/m1` (c17c60df7); commit dan push tanpa force. Tidak merge, tidak deploy.
Kartu (baca `bd show` dulu, cek dulu apakah sudah ada di m1):
- legend-igclp: validasi XML Coretax terhadap XSD resmi DJP sebelum ekspor; XSD disimpan di repo (sumber resmi, catat versi + URL di komentar), tanpa unduh saat runtime; XML tidak valid ditolak dengan kode error jelas. Context7/dokumen resmi untuk library validator XSD Node yang dipilih (tanpa binary native berat bila bisa).
- legend-0cnqt: event `tax_report.exported` benar-benar di-emit (outbox) saat ekspor sukses, sekali per ekspor; kode error laporan pajak masuk katalog teks/i18n (`node --test tests/text-contract.test.mjs`).
Paralel: Explore `accounting-tax-reports.service.ts` + events, satu implementer per kartu, test-writer gagal-dulu, test-runner, satu reviewer. Batas 1 tsc bila free < 60% (ram-guard status).
Bukti: test gagal-dulu lalu hijau, test akuntansi/pajak lewat heavy setelah commit terakhir, prettier, eslint, typecheck api sekali.
Laporan: cabang, SHA, test, temuan reviewer, angka subagent. Komentari kartu. Lapor sekali saat selesai.
