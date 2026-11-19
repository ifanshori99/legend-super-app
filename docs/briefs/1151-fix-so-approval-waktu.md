# 1151 Fix SO approval waktu (1148: P1 + P2, tingkat K)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore pemanggil, test-writer, implementer).
Lanjutkan cabang `ghostex/ai-layar-approval-waktu-1137` (head bf1567dec) di worktree dari Ghostex. Push tanpa `--force`. Tanpa migrasi.
Laporan SO: `docs/qa/second-opinion-approval-waktu-1148.md` (folder utama).

Keputusan CTO (gagal-aman, waktu lebih lambat menang):
1. P1 `platform-approval.service.ts:1412`: waktu cek = MAKSIMUM dari `options.now` pemanggil dan jam server yang dibaca SESUDAH semua lock (DB `clock_timestamp()` di transaksi yang sama, atau `Date.now()` sesudah lock terakhir). Jam server tidak pernah dilewati walau `options.now` ada. `decided_at` = waktu cek itu.
2. P2 `:1418` + `sole-owner-self-approval.ts:70`: waktu cek diambil sesudah `lockAndCheckSoleOwnerSelfApproval` juga (lock terakhir). Terlambat = `APPROVAL_REQUEST_EXPIRED`, rollback.
Pemanggil (cuti, koreksi absen, stok opname, lembur, payout/refund approval) tetap jalan; jangan ubah kontrak HTTP.

Bukti: test gagal-dulu (merah di bf1567dec) sesuai usul test di laporan SO: pemanggil memberi `options.now` lama lalu tenggat lewat sebelum masuk fungsi; dua koneksi dengan barrier menahan lock role-assignment tenant melewati tenggat pada jalur sole Owner. Regresi terarah approval + pemanggil lewat `heavy`. Typecheck API sekali lewat `heavy`. Prettier/eslint. `architect` xhigh sekali.
Laporan: head SHA, temuan tertutup, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
