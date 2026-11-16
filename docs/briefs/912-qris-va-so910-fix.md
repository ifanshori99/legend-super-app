# 912 Perbaikan 3 P1 SO QRIS/VA 910 + legend-p5xrv
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Uang: architect effort xhigh. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer gagal-dulu per P1, satu implementer per P1 dengan berkas terpisah, test-runner, lalu 1 architect xhigh atas seluruh diff).
Cabang: worktree-mu dari `fix/qr-va-queue-after-paid-xzu4l` (fd34ec962); commit ke cabang itu, push tanpa force. Tanpa migrasi bila bisa (sementara 0632+). Tidak merge, tidak deploy.
Temuan lengkap + usul test: `git show origin/qa/second-opinion-qris-va-906-908:docs/qa/second-opinion-qris-va-906-908.md`.
Keputusan CTO (aturan yang tidak membuat uang hilang):
- P1-1: lepas VA hanya bila jawaban penyedia terbaca dan bukan paid. Hasil `settleGatewayIntentNow()` wajib diperiksa; error, paid, atau jawaban tidak meyakinkan = TOLAK lepas (bukan lepas).
- P1-2: antrean TIDAK menutup baris karena timer. Tutup hanya dengan bukti kode tertutup/final dari penyedia. Setelah 72 jam/7 hari: turunkan frekuensi (mis. tiap 24 jam) dan masukkan baris ke daftar finance exception; tidak ada penutupan tanpa bukti. Ganti konstanta 908.
- P1-3: cabang dead/expired wajib memeriksa extraPayments setelah `parkExtraPayments`; final hanya setelah semua transaksi tambahan positif tercatat atau diparkir tepat sekali.
- legend-p5xrv: poll biasa (`syncPendingIntent`) ikut memarkir transaksi tambahan tepat sekali per provider+providerRef, tidak melunasi order.
Bukti selesai: test gagal-dulu lalu hijau per P1 dan p5xrv (sesuai usul test SO), test area QRIS/VA hijau lewat `heavy` setelah commit terakhir, pra-gate AGENTS.md (prettier, eslint, typecheck api+web), architect xhigh tanpa P1.
Laporan: SHA, hasil test, temuan architect, angka subagent (total, puncak bersamaan). Komentari legend-xzu4l, legend-5wn1e, legend-p5xrv.
