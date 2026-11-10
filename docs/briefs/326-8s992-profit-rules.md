# legend-8s992: aturan founder bagi hasil + sisa test

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (uang, akses): satu subagent architect review.
Basis: `git worktree add .worktrees/8s992 -b ws/8s992-profit-rules ws/profit-share` (9e3d3928). Jangan checkout folder utama. Jangan push.

## Kerja (test gagal-dulu untuk tiap butir)
1. Aturan founder (jawaban Q82-Q84, 10 Nov). Tambahkan juga sebagai bagian "WS-07: bagi hasil pemegang saham, aturan founder" di `docs/DECISIONS.md` cabangmu:
   - Sisa pembulatan ke pecahan terbesar, seri deterministik. Total terbagi = total laba persis.
   - Koreksi minus: total per pemegang saham minimal nol; sisa yang tidak terserap tercatat terbuka (jangan dibebankan ke pemegang lain). Jurnal balik otomatis tetap.
   - Izin baru terpisah untuk mengubah porsi saham, beda dari izin menyetujui pembagian. Daftarkan di permission list dan seed role sesuai pola yang ada; jangan beri ke role kasir.
   Bila salah satu sudah ada di kode, buktikan dengan test dan catat.
2. Test balapan: FK menolak setelah file tersimpan, file harus dihapus (tidak yatim).
3. Jalankan ulang 10 file test bagi hasil sesudah prettier.
4. Typecheck dan test terkait lewat `heavy`. Architect review delta, temuan nyata dibetulkan.
5. Commit lokal, `bd comment legend-8s992`, update `docs/PROGRESS.md`.

Migrasi baru hanya bila perlu: nomor sementara 0221, `when` 1794300000000. Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain.

## Laporan
Sekali di akhir: SHA, test gagal-dulu per butir, temuan architect.
