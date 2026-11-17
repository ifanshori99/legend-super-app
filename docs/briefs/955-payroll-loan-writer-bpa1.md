# 955 Payroll: penulis potongan pinjaman + format BPA1 resmi (2 kartu, K uang + migrasi)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang + migrasi).
Cabang: worktree-mu dari `origin/ghostex/ba6c8a6b` (cdec4ae29, payroll 949). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0461-0465 (nomor kerja).
Kartu (`bd show <id>`; claim dulu):
- legend-8tfvr: penulis potongan pinjaman. Desain dulu oleh subagent architect xhigh: kapan saldo pinjaman turun (saat lock), status yang dihitung guard, restore tepat sekali saat reversal berpasangan dengan penurunan saldo. Lock/simulate tidak lagi menolak run berpinjaman.
- legend-y6w4q (P1): ekspor A1 ikut format resmi DJP. Rujukan: `git show ux/customer-order-benchmark:docs/qa/coretax-bpa1-format.md` (27 elemen, urutan wajib, nama resmi). `Article21IncomeTax` = PPh21 yang sudah dipotong dari slip locked/paid, jangan dihitung ulang. Test validasi terhadap skema dari converter DJP bila bisa disimpan sebagai fixture.
Jangan sampai rugi: test bukti potongan tidak melebihi sisa pinjaman, tidak potong ganda lintas run, reversal mengembalikan tepat sekali, total A1 = jumlah slip tersegel.
Paralel: architect (desain 8tfvr) + Explore + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu; lalu test-runner + architect xhigh bersamaan. Suite besar hanya setelah kode beku (Retro 39).
Bukti: gagal-dulu lalu hijau; test area payroll lewat heavy setelah commit terakhir; pra-gate AGENTS.md (prettier, eslint, db:generate kosong, registry migrasi, typecheck API + shared sekali); architect tanpa P1.
Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari kedua kartu. Lapor sekali di akhir.
