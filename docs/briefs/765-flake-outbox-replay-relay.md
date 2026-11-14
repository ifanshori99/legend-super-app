# 765 Flake core-outbox-consumer relay setelah replay (legend-whg2)
Peran: engineer (Codex, kartu S, test/flake). Base: milestone/m1. Cabang: fix/flake-outbox-replay-relay. Tanpa migrasi.
Masalah: di suite penuh core-outbox-consumer.test.ts:230 ('holds every later sequence … until an operator replays it') relayOutbox setelah replayOutbox mengharap 1, dapat 0. Lolos sendiri. Kemungkinan bergantung urutan/waktu (jam, baris outbox dari test lain, atau lease yang belum lewat).
Langkah: cari akar masalah dulu (baca test dan service outbox; coba reproduksi dengan berkas tetangga yang menulis outbox di run yang sama, 1 worker). Perbaiki test atau kode sesuai akar masalah; jangan menghapus assert atau menambah retry buta. Bila akar masalah ternyata bug di service (bukan test), lapor dulu sebelum mengubah perilaku production.
Bukti: berkas itu plus 2-3 berkas outbox lain dalam satu run lolos 3x berturut.
Aturan umum: baca ~/.agents/team/roles/engineer.md dan "Paralel dulu" di ~/.agents/team/TEAM.md. Kerja berat lewat `heavy`, satu job sekaligus, tanpa loop. Satu reviewer. Pra-gate AGENTS.md. Commit, push cabang tanpa force, jangan merge. Lapor angka subagent.
