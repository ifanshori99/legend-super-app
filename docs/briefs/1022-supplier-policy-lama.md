# 1022 Policy persetujuan supplier lama tanpa tingkat dasar (legend-98etn)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang + migrasi data): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore policy + UI pengaturan, test-writer, implementer migrasi, implementer web).

Base: `ghostex/perbaikan-so-998-kas-supplier` (806d14bf9, 1008: PUT approval-policies tolak matriks supplier_payment tanpa tingkat 1 threshold 0/null, 422 berbahasa Inggris). Cabangmu antre SESUDAH 1008.
Kerja: (1) migrasi backfill: tiap baris `supplier_payment` tanpa tingkat dasar diberi tingkat 1 threshold 0 dengan peran penyetuju tingkat terendah yang sudah ada (membatasi: tidak pernah menghapus tingkat, tidak menurunkan syarat). Idempoten, tenant lain tidak tersentuh, aman di RLS (role legend_app). (2) pesan 422 diganti kode galat + teks Indonesia di katalog; layar pengaturan persetujuan menampilkannya di samping baris yang salah.
Test wajib: backfill pada data lama -> pembayaran supplier tetap butuh orang kedua; baris yang sudah benar tidak berubah; jalankan dua kali tidak menggandakan; PUT dengan matriks salah -> kode galat baru; UI menampilkan pesan. Gagal-dulu di base. Nomor migrasi kerja 0638-0639; registry/test memakai nomor sama; db:generate kosong.
Bukti: test terarah lulus (sebut berkas, termasuk supplier-payment-*), text-contract, prettier/eslint, typecheck API + web lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
