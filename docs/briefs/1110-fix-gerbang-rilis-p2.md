# 1110 Perbaikan 3 P2 second opinion gerbang rilis (tingkat K: gerbang uang/deploy)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (satu implementer per temuan, file tidak bertumpuk).
Laporan SO: `docs/qa/second-opinion-gerbang-rilis-1109.md` (F1-F3: lokasi, skenario, usul test ada di sana). Push tanpa `--force`. Tanpa migrasi.

## Cabang per temuan (tiap cabang punya worktree/checkout sendiri; jangan gabung cabang satu sama lain)
- F1 -> `ws/1097-gerbang-payout-rekon` (head 7585a887f): gerbang bukti payout wajib gagal bila histori masih pending. Aturan membatasi: ragu = gerbang gagal (block), bukan lolos.
- F2 -> `ws/1098-gerbang-doit-duitku` (head 7ada4e49b): perintah/petunjuk sertifikasi Duitku tidak boleh melewati probe saat kredensial tersedia; opt-in tetap eksplisit, tidak memanggil production, tidak mencetak rahasia.
- F3 -> `ws/1100-gerbang-deploy` (head 2db9947b6): runner gerbang hanya menerima satu statement SELECT (atau WITH yang berakhir SELECT, tanpa CTE penulis); SET, COPY, DO, CALL, dan statement lain ditolak sebelum dijalankan. Test negatif untuk tiap jenis.

## Bukti
Tiap temuan: test merah di head lama, hijau di head baru (test terarah lewat `heavy`). Prettier/eslint berkas yang diubah. Typecheck API sekali per cabang lewat `heavy` (boleh satu run di cabang terakhir bila antre > 60 menit; tulis di laporan). Subagent architect effort xhigh: review gabungan ketiga diff, sekali.

## Laporan
Per temuan: cabang, commit, head SHA (push), risiko. Tambah baris docs/merge-queue.md? Jangan; CTO yang mengubah. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali (tunggu job dengan Monitor).
