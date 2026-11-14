# 849 Pulihkan sumber board /design-system/v2 (engineer Codex, S kecil)

Kartu: legend-wzdb. Detail: grep id di .beads/issues.jsonl. Jangan menjalankan bd.

- Langkah 0: `git log --all --oneline --grep=legend-wzdb` dan cek apakah apps/web/src/components/design-system/v2/ sudah ada di milestone/m1.
- Pulihkan berkas board dari commit 996bcfe (git show 996bcfe:<path>) ke basis sekarang; sesuaikan import yang berubah. Bila rute yang memasangnya hilang, pasang ulang di area yang hanya untuk staf internal sesuai docs/frontend.md, bukan rute publik.
- Jangan sentuh fitur produk lain. Tanpa migrasi.
- Bukti: typecheck web lewat heavy, eslint/prettier pada berkas berubah, teks UI terdaftar di katalog bila ada teks baru.
- Commit + push tanpa force. Lapor dengan angka subagent.
