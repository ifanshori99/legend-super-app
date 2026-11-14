# 783 Ajakan tautkan WhatsApp di layar poin + lembar QR meja (legend-vnvg, legend-oamb)
Peran: ui-engineer (baca ~/.agents/team/roles/ui-engineer.md), tugas kecil. Ikuti ~/.agents/team/ui-standard.md dan DESIGN.md.
Basis: worktree dari origin/milestone/m1. Tanpa migrasi.
Langkah 0 (Explore paralel, satu per kartu): apakah kartu sudah dikerjakan di m1 atau cabang lain (`git log --all --grep <id>`, `git branch -r`). Sudah ada: lapor dan berhenti untuk kartu itu.
1. legend-vnvg: layar poin/reward member menampilkan ajakan ke /masuk/hubungkan bila getCurrentAuth.whatsAppVerified false (ganti empty state generik). Teks baru masuk katalog text-contract.
2. legend-oamb: grid label A4 lembar QR meja (sekarang 2 kolom di semua lebar) disetel untuk cetak; cetak ulang tidak memutar token. Bila butuh endpoint API baru (reprint read-only): JANGAN buat, catat sebagai kartu lanjutan dan selesaikan bagian grid saja.
Bukti: test unit gagal-dulu, e2e mock yang tersentuh, ui-auditor subagent, screenshot 390 + 1280 per layar (heavy --browser sekali setelah server dev siap). Typecheck web sekali lewat heavy. prettier/eslint, node --test tests/text-contract.test.mjs.
Commit+push ke cabang kerja, jangan merge. Lapor dengan angka subagent.
