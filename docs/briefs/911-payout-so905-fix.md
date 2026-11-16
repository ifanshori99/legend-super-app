# 911 Perbaikan SO payout 905 (2 P1 + 2 P2) + legend-r86qa + legend-izza4
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Uang + akses + migrasi. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran: 1 architect (effort xhigh) mendesain P1-1 dulu sambil Explore + test-writer gagal-dulu untuk P1-2, P2-3, P2-4, r86qa, izza4; lalu satu implementer per temuan (berkas terpisah), test-runner, dan 1 architect xhigh atas seluruh diff.
Cabang: worktree-mu dari `fix/payout-trusted-boundary-905` (5eeaa683d); commit ke cabang itu dan push tanpa force. Migrasi sementara mulai 0652 (merge train menomori ulang). Tidak merge, tidak deploy.
Temuan lengkap: `git show origin/qa/second-opinion-payout-905:docs/qa/second-opinion-payout-905.md`.
Keputusan CTO (aturan yang membatasi pembayaran):
- P1-1 (ID sesi cukup untuk menyamar dua penyetuju): fungsi tepercaya harus menerima bukti persetujuan per operasi yang tidak bisa dibuat `legend_app` dari data yang bisa ia baca (mis. grant sekali pakai terikat operasi+aktor+waktu, diterbitkan jalur step-up password, hanya hash tersimpan, rahasia di tabel milik `legend_payout`). Desain final dari architect; tolak bila grant hilang/basi/dipakai ulang/aktor sama.
- P1-2 (ganti bukti proposal melepas hold closure): bukti proposal terbuka tidak boleh diganti ke kunci yang tertutup/macet; trigger closure juga berjalan pada UPDATE `evidence_key`. Bila ragu: larang ganti bukti, wajib batalkan proposal dan buat baru.
- P2-3: binding dan `payout_assert_proof` wajib `batch_id` dan entitas hukum yang sama.
- P2-4: recon tidak menandai penggantian bukti sah sebagai `binding_duplicate` (bedakan binding proposal yang sudah dibatalkan).
- legend-r86qa: retry/resolve (`exported→failed/not_sent/succeeded`) lewat fungsi tepercaya, cabut hak `legend_app` yang tersisa.
- legend-izza4: setelan `app.payout_settle` tidak lagi dipercaya.
Bukti selesai: test gagal-dulu lalu hijau per temuan (termasuk eksploit sebagai `legend_app` ditolak), seluruh test payout hijau lewat `heavy` setelah commit terakhir, migrator non-superuser lulus, pra-gate AGENTS.md, architect xhigh tanpa P1.
Laporan: SHA, rentang migrasi, hasil test, desain P1-1 singkat, temuan architect, angka subagent (total, puncak bersamaan). Komentari r86qa dan izza4.
