# 774 heavy: head-of-line blocking dan kunci browser saat menunggu jalur (legend-v75d4)
Peran: engineer (Codex, kartu S, tooling, effort high). Folder: ~/.claude/scripts (heavy) dan tests/; bukan repo Legend. Cadangan di /tmp/legend-v75d4-backup sebelum edit. Pasang perubahan ATOMIK (tulis berkas sementara lalu mv), jangan timpa langsung: job heavy sedang berjalan dan Bash membaca ulang skrip (aturan TEAM.md 7).
Masalah dan usul: `bd show legend-v75d4` dari repo Legend.
Batas: jangan ubah jumlah jalur, batas RAM/disk, aturan tsc free>=70%, atau browser satu sekaligus. FIFO tetap berlaku di dalam kelas yang sama. Jangan pkill/killall; jangan ganggu job yang sedang jalan; uji dengan direktori kunci sementara lewat env.
Bukti: test shell gagal-dulu untuk (1) tsc kepala yang tertahan aturan free tidak menahan e2e/test non-tsc di jalur 2, (2) job browser tidak memegang kunci browser selama menunggu jalur (job browser lain tidak terblok), (3) tidak ada kelaparan: tsc tetap dapat jalur saat syarat terpenuhi. Semua test-*.sh lulus.
Lapor: berkas diubah, test, angka subagent.
