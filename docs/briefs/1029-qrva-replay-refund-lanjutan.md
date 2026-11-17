# 1029 QR/VA lanjutan: replay kunci + refund otomatis gagal (legend-kis0u, legend-p45yq, legend-nqfov, legend-9pz0m)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore alur replay idempotensi ganti metode + refund otomatis dana parkir, test-writer gagal-dulu per kartu, satu implementer per kartu bila file terpisah).

Base: `ghostex/1004-fix-temuan-so-qr-va` (b5777cba7). Cabangmu antre SESUDAH 1004 di merge train. Sumber temuan: docs/qa/second-opinion-qrva-940-969.md dan `bd show <id>` tiap kartu. Keputusan founder Q15 tetap: kode lama di-void, bayar telat ke kode lama = refund otomatis, tidak ada bayar ganda.
Jangan sentuh berkas refund provider/webhook refund milik thread 1025 (fundBlockedSql, markProviderRefunded) dan finalizeReservationDepositRemainders milik 1028.

Kartu:
- legend-kis0u: replay kunci lama mengembalikan VA yang sudah di-void sebagai pending (closePayLinkIfNotPending). Replay harus mengembalikan status nyata (void), tidak membuka kode lama lagi.
- legend-p45yq: replay kunci idempoten sama saat ganti metode jangan 409 konflik bila voided=[]; respons sama seperti panggilan pertama.
- legend-nqfov: replay e-wallet/kartu baca respons tersimpan sebelum cek metode/channel saat ini.
- legend-9pz0m: refund otomatis dana parkir yang gagal (approval_expired) dibuka ulang otomatis dengan batas percobaan, bukan jatuh ke staf diam-diam; tetap satu refund per dana (tidak ganda).

Test wajib (gagal-dulu di base): tiap kartu satu test; replay ganda tidak membuat kode/pembayaran baru; refund dibuka ulang tidak pernah melebihi dana parkir; event/webhook ganda; tenant lain; outlet tidak rugi, tamu tidak dibayar lebih. Berkas test 1004 tetap hijau.
Migrasi hanya bila perlu, nomor kerja 0647-0648. Bukti: test terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per kartu, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
