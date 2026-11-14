# 775 QRIS hold C1 (legend-yhia9.2)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Tingkat K: uang + migrasi. Architect subagent effort xhigh sebelum lapor.
Basis: worktree dari origin/milestone/m1. Langkah 0: merge `ws/qris-dp-due` (54682a08, 4 test uang) dan ambil `docs/design/qris-dp-intent.md` dari cabang `design/qris-dp-edge-emergency` (git checkout <cabang> -- <path>). Konflik di berkas uang: lapor, jangan tebak.
Langkah 0b: baca §10 desain (pertanyaan untuk founder). Cek `bd memories qris` dan `bd show legend-yhia9`. Bila keputusan yang dibutuhkan C1 belum ada: lapor pertanyaannya ke CTO, berhenti sebelum menulis kode. Tanpa keputusan: pilih aturan paling membatasi pembayaran (arah CTO di legend-yhia9).
Isi: kartu C1 di §9 desain (D-01, D-02, D-04, §5, §6). NOMOR MIGRASI: desain menulis 0419-0420, pakai 0368 dan 0369 (m1 sampai 0365; 0366-0367 dipesan brief 769). Jangan sentuh 0421 (C3).
Paralel: Explore (pemanggil voidPendingQrisTenders, mutator uang POS), test-writer (§7 tabel kasus + §8 test gagal-dulu), implementer migrasi+schema, implementer service+guard. Berkas tidak bertumpuk.
Bukti: test §8 gagal dulu lalu lulus; test uang tidak ada pihak dibayar lebih; `pnpm db:generate` kosong; typecheck api lewat heavy sekali; prettier/eslint. Antre heavy dengan HEAVY_QUEUE_ID, jangan job paralel.
Jangan merge ke main. Commit+push ke cabang kerja.
Lapor: berkas, test, temuan architect, angka subagent (total, puncak, pemegang token heavy).
