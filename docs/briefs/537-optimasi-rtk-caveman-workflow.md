# 537 Optimasi rtk, caveman, dan workflow tim (infra, tingkat S)
Peran: engineer (~/.agents/team/roles/engineer.md), Sonnet. Permintaan founder 12 Nov: lebih cepat, tetap akurat, tepat, hemat token, hasil bagus. Jangan ubah kode produk Legend kecuali C1. Jangan sentuh rahasia. Jangan restart/ubah sesi yang sedang jalan.
Data awal: brief 529 (laporan: rtk terpasang global dengan pengecualian, hemat ~700 token per git status/ls; graphify ditolak), RETRO.md Retro 18-19 (heavy gagal 18-23%, gate batch48i gagal 3x karena Postgres test OOM 725/768 MiB; CTO 84% token dari baca ulang konteks).
Bagi paralel: Explore per bagian A/B/C, implementer per bagian, test-runner untuk tests/*.sh hook.

A. rtk
1. `rtk discover` (atau setara) atas riwayat sesi 2 hari: perintah yang sering dan aman tapi belum ditulis ulang. Tambah ke cakupan hanya bila output tidak dipotong (bukti: bandingkan mentah vs rtk, tidak ada "+N more"/truncated).
2. Codex: cek apakah rtk mendukung Codex (hook atau instruksi AGENTS). Pasang hanya bila bisa diuji tanpa merusak; kalau tidak, catat alasan.
3. Riwayat `rtk gain` ter-reset (21 -> 1 baris): cari sebab, pastikan tercatat agar retro bisa mengukur.
B. caveman
1. Periksa level dan cakupan sekarang (CTO, thread, subagent, Codex). Pastikan teks ke founder tetap bahasa Indonesia utuh dan laporan thread tetap memuat angka subagent, file:line, caveat (bila perlu, aturan pengecualian di konfigurasi caveman).
2. Hemat token input (penyumbang terbesar): ukur token berkas yang dibaca tiap sesi (~/.agents/main.md, ~/.agents/team/TEAM.md, roles/*.md, standing-instructions, memory MEMORY.md). Untuk berkas agent-facing (bukan main.md milik founder), padatkan dengan skill caveman `compress` atau tulis ulang ringkas TANPA menghilangkan aturan: backup dulu, diff per aturan (daftar aturan sebelum = sesudah), ukur token sebelum/sesudah. Bila ragu satu aturan, biarkan.
C. Workflow
1. Postgres test OOM: bila log run 4 merge train (G6jro, STARTER_TEST_PG_MEM=1536m) lulus tanpa OOM, jadikan 1536m default di compose.test.yaml (cabang ws/test-pg-mem dari origin/milestone/m1, commit + push cabang, jangan merge). Pastikan total memori Colima (3 GiB) cukup untuk 2 gate bersamaan atau batasi heavy gate DB jadi 1 sekaligus.
2. Klasifikasi heavy gagal 24 jam terakhir (~/.claude/state/heavy-fail): sebab alat (OOM, path placeholder, lock, timeout) vs test nyata. Perbaiki sebab alat di skrip bila aman, dengan test skrip.
3. Kolom `orphans` ram-sampler salah hitung (Retro 18-19): perbaiki dengan test.
4. Satu baris aturan baru per perbaikan di TEAM.md "Hemat waktu dan token" (padat).
Selesai: semua ~/.claude/scripts/tests/*.sh lulus, angka sebelum/sesudah per bagian (token, % gagal), cara rollback, apa yang tidak dikerjakan dan kenapa. Satu laporan.
