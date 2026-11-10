# Brief: engineer — triage kartu siap backend m1 (bd ready)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu"), lalu ikuti. Tugas ini hanya membaca kode dan memperbarui kartu bd; tidak mengubah kode.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Baca `milestone/m1` lewat `git show`/`git grep` atau worktree detached sementara (hapus sesudahnya). Jangan checkout di folder utama.

## Tujuan
`bd ready` berisi sekitar 385 kartu. Banyak kartu WS lama (BE, INT, P1/P2) kemungkinan sudah dikerjakan lewat cabang lain dan sudah ada di m1, tetapi tidak pernah ditutup. CTO butuh daftar kartu yang benar-benar siap dikerjakan.
Untuk tiap kartu P1 dan P2 di `bd ready -n 400` yang bukan FE, bukan EXT, bukan Design/UI, dan bukan epic (sekitar 30 kartu; daftar dengan `bd ready -n 400 | grep -E " P[12] "`):
1. Baca kartu (`bd show`), cocokkan setiap kriteria penerimaan dengan kode dan test di m1 (file:baris).
2. Semua kriteria terbukti di m1 dengan test: `bd close <id> --reason "<bukti file:baris dan nama test>"`.
3. Sebagian: `bd comment <id>` berisi yang sudah ada, sisa kerja konkret, dan ukuran (S/M/L).
4. Belum ada sama sekali: `bd comment` singkat "belum ada di m1 per <tanggal>" dan dependensi yang terlihat (kartu lain, akun eksternal, gerbang UI founder).
Pakai subagent `Explore` paralel (satu kartu atau kelompok kecil per subagent, maks 8 sekaligus), lalu periksa sendiri bukti sebelum menutup kartu.

## Scope
Boleh: membaca kode, `bd show/comment/close/update --priority`. Jangan: mengubah kode, membuat cabang kerja, menutup kartu tanpa bukti test, menyentuh kartu yang sedang `in_progress` atau `review`, kartu FE/UI (menunggu gerbang founder), kartu EXT (butuh akun eksternal).

## Bukti selesai
Tabel di laporan: id, judul singkat, keputusan (ditutup / sebagian / belum), sisa kerja, ukuran, dependensi.

## Laporan
Sekali: tabel di atas, lalu 5 kartu yang kamu rekomendasikan dikerjakan berikutnya untuk m1 (alasan satu baris per kartu). Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
