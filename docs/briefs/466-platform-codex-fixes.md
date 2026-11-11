# Brief: perbaikan temuan second-opinion platform 463 (dheu/ca4l/8en8)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Cabang `ws/dheu-secrets-support` (4dfd3ceb), worktree yang sama dengan 463. Keputusan CTO: semua nyata, area akses -> architect effort xhigh setelah perbaikan. Migrasi bila wajib: nomor sementara 0289.

1. P1 `docs/deployment.md:308`: rotasi kunci dua tahap. Rollout 1: semua proses kenal kunci N, versi aktif tetap lama. Rollout 2: aktifkan N. Tulis langkahnya + guard di kode bila ada (tolak aktifkan versi yang belum dikenal semua pembaca bila bisa dideteksi; minimal dokumentasi + test bahwa pembaca dengan ring lama gagal jelas, bukan diam).
2. P2 `platform-support.service.ts:1359`: revoke wajib cek assignment owner aktif di dalam transaksi sebelum mutasi. Test gagal-dulu: custom role dengan `org.support_access.approve` + MFA, bukan owner -> ditolak.
3. P2 `platform-support.service.ts:1316`: cleanup sesi gagal -> sesi impersonasi masih terbaca lewat `get-session`. Validasi grant aktif saat membaca sesi (sumber kebenaran = grant). Test: cleanup dipaksa gagal, get-session setelah revoke ditolak.
4. P2 `docs/deployment.md:309`: sediakan jalur operasional rotasi (script CLI di `apps/api/scripts/` atau job) dengan konteks tenant tepercaya, laporan sisa + gagal. Cakup juga pemakaian `sealSecret` lain (MFA, identitas, NPWP) atau tulis kartu bd lanjutan bila besar (sebut id di laporan).
5. P3 `docs/deployment.md:312`: koreksi inventaris: HRIS/payroll v1 tetap kunci 1 untuk tulis baru.

Paralel: implementer per butir 1+4+5 (docs/script), 2, 3; test-writer gagal-dulu untuk 2 dan 3; lalu architect xhigh. Bukti: test gagal-dulu, test terarah hijau, eslint+prettier file berubah, typecheck api heap 6144, commit+push. Laporan: commit, angka test, angka subagent (total, puncak, pemegang heavy).
