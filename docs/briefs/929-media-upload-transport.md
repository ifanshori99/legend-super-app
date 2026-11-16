# 929 Transport unggah foto penerimaan + kas kecil (legend-0una, WS-06)
Peran: engineer Codex (baca ~/.agents/team/roles/engineer.md). Effort medium. Tanpa uang/akses; migrasi hanya bila wajib (sementara mulai 0670).
Cabang: worktree-mu dari `milestone/m1` (a8e6036ab); commit dan push tanpa force. Tidak merge, tidak deploy.
Kartu: `bd show legend-0una`. Ikuti batas body 100 kB API (unggah besar jangan lewat JSON body; pakai jalur unggah terpisah sesuai pola yang ada), validasi tipe/ukuran, filter kepemilikan tenant di SQL, jangan simpan rahasia di browser.
Paralel: Explore pola unggah yang ada; test-writer gagal-dulu; implementer; test-runner; satu reviewer.
Bukti: test gagal-dulu lalu hijau, test area lewat heavy, pra-gate AGENTS.md.
Laporan: cabang, SHA, migrasi, test, temuan reviewer, angka subagent. Komentari kartu. Lapor sekali saat selesai.
