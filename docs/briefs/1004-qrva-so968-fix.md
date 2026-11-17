# 1004 Perbaikan temuan SO 968 QR/VA (P1 refund otomatis kode lama + 2 P2)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore alur guest_method_change + refund otomatis yang sudah ada, test-writer gagal-dulu per temuan, satu implementer per kartu bila file terpisah).

Sumber: docs/qa/second-opinion-qrva-940-969.md (lokasi, skenario, usul test). Keputusan founder Q15 (sudah final): tamu boleh ganti metode QR/VA; kode lama di-void; pembayaran telat ke kode lama tidak boleh menjadi bayar ganda: buka refund otomatis.
Base: `ghostex/969-duitku-e-wallet-kartu-be` (ad0507789, sudah di int/batch84). Cabang 995 (892f58a11, legend-8m23m) juga mengubah jendela method_changed: baca `git diff 1b0fd2a9e 892f58a11 -- apps/api/src/services/` dulu dan jangan bertentangan dengannya. Cabangmu antre SESUDAH 969 dan 995.

Kartu:
- legend-hs1rc (P1): uang masuk ke kode lama setelah guest_method_change buka permintaan refund otomatis memakai alur refund yang ada (jangan buat jalur uang baru), idempoten per pembayaran provider, tidak pernah melebihi nilai yang masuk, order tetap dibayar sekali.
- legend-p45yq (P2): dua request token dengan kunci idempoten sama saat ganti metode: keduanya dapat hasil sama, bukan sukses + konflik.
- legend-nqfov (P2): replay e-wallet/kartu membaca respons tersimpan sebelum assertGuestMethodOffered/cek channel, supaya replay tidak gagal saat routing/provider berubah.

Jangan sampai rugi, test wajib: pembayaran telat ke kode lama -> tepat satu refund sebesar nilai masuk; webhook ganda -> tetap satu refund; order tidak lunas ganda; outlet tidak menanggung selisih; tenant lain tidak tersentuh. Test gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0612-0614 (lapor CTO bila lebih).
Bukti selesai: test terarah QR/VA + refund lulus (sebut berkasnya), prettier/eslint, typecheck API (+web/shared bila tersentuh) lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per kartu, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
