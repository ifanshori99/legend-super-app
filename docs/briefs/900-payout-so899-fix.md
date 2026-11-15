# 900 Payout: perbaikan second opinion 897 (2 P1 + 5 P2)

Lanjutkan `fix/payout-so895-897` (1c3067deb), tanpa force. Kartu `legend-p2v4s`. Sumber: `docs/qa/second-opinion-payout-897.md`. Migrasi baru nomor sementara 0641-0643.

## Keputusan CTO (aturan membatasi; jangan ditanyakan ulang)
- P1 gerbang backfill: jadikan global. Selama ada operasi historis atau bukti historis yang belum terikat/belum di-fingerprint di tenant mana pun, return/overpaid/koreksi dengan bukti baru ditolak 409 PENDING di semua tenant (production nanti mulai kosong, jadi gerbang ini terbuka seketika di sana; kartu `legend-9bfh7` memeriksanya saat rilis).
- P1 dua operasi historis dengan key sama: jangan menebak. Semua operasi yang berbagi key masuk daftar macet finance (`payout_proof_stuck`) dan key itu tidak bisa dipakai lagi sampai finance menutupnya.
- P2 guard fee sebelum jurnal selesai: pindahkan pemeriksaan ke constraint trigger DEFERRABLE INITIALLY DEFERRED (dicek saat commit), sehingga baris jurnal tambahan dalam transaksi yang sama ikut terhitung.
- P2 sumber dana: `source_gl_account_id` diambil dari rekening yang dibekukan batch dan wajib sama; NULL atau beda ditolak.
- P2 fee historis NULL: tidak boleh di-flip otomatis; masuk daftar finance, bukan diterima. Ubah test yang sekarang mengharapkan penerimaan, jelaskan di laporan.
- P2 binder kelaparan: `unboundOperations` menghormati `next_attempt_at` dan cursor maju.
- P2 deadlock: satu urutan lock untuk confirm/resolve/backfill (advisory lock hash dulu, baru tulis baris fingerprint), dengan test paralel bila bisa.
- P2 koreksi palsu via role aplikasi: tetap kartu legend-i01jp, jangan dikerjakan.

## Bukti selesai
- Test gagal-dulu per temuan di 1c3067deb, lalu hijau; suite payout/GL terarah hijau dengan exit code dari log; test pasangan (registry migrasi, guard) diperbarui.
- Pra-gate AGENTS.md (prettier, eslint, typecheck api+web lewat heavy, `db:generate` kosong).
- Satu subagent architect xhigh atas diff; temuan nyata dibetulkan.
- Push tanpa force. Lapor SHA, migrasi, test merah→hijau, angka subagent. Jangan merge, jangan deploy.
