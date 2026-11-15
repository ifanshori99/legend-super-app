# 903 Perbaikan 2 P1 second opinion QRIS 896
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (1 test-writer/implementer per P1, lalu test-runner, lalu 1 architect effort xhigh atas diff-mu).
Cabang: kerja di worktree-mu, lalu commit ke `fix/qris-hold-so-879` (tip 0f5863718) dan push tanpa force. Tidak ada migrasi baru, tidak merge, tidak deploy.
Temuan lengkap (berkas:baris, skenario, usul test): `git show origin/qa/second-opinion-qris-896:docs/qa/second-opinion-qris-896.md`.
Keputusan CTO (aturan yang membatasi pembayaran):
- P1-1: tender standalone `edc_card`/`edc_qris` ikut guard dana terbuka (409 `FUNDS_UNRESOLVED`) di cabang `!settlesEcrRequest`, sebelum override/persetujuan dipakai. Tanpa tender, ledger, atau approval-use baru saat ditolak; berhasil setelah dana diselesaikan. Pengecualian Q7 hanya untuk request ECR yang sudah berjalan.
- P1-2: jawaban `paid` tanpa nominal positif = jawaban belum meyakinkan: jangan isi `provider_final_at`, event tetap bisa di-retry, poll tetap memilih intent itu. Final dari jalur parkir hanya bila receipt/dana positif benar-benar tertulis atau ditemukan. Uji juga intent `failed` nonfinal di jalur poll (`payment.service.ts:2777`).
Bukti selesai: test gagal-dulu lalu hijau untuk tiap usul test di laporan SO (termasuk "uang dicatat atau diparkir tepat sekali" setelah status pulih), test terarah area QRIS hold hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api+web), architect xhigh tanpa P1.
Laporan: SHA, hasil test, temuan architect dan perbaikannya, angka subagent (total, puncak bersamaan). Update kartu legend-ad95t dan legend-o6q8i dengan komentar.
