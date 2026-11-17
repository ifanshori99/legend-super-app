# 986 Merge train batch84
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` 1b0fd2a9e (batch83, migrasi ujung 0442). `git fetch` dan ambil tip terbaru tiap cabang sebelum menyusun; lewati yang sudah ancestor m1.
Isi (urut, maks 7):
1. `fix/966-scanner-suggestion` d8785fcbe (S legend-julap: filter AI purchasing di SQL; tanpa migrasi)
2. `ghostex/dd932307` 71b1155f7 (K uang/migrasi payroll 955+972; migrasi kerja 0461, 0515). Menggantikan `ghostex/1a1b16fe` dan `ghostex/972-payroll-pinjaman-pph21` (sudah termuat). JANGAN `ghostex/a846fbcc` (983 masih bekerja di atasnya).
3. `ghostex/965-doit-cegah-tagih-dobel` 3793464f1 (K uang/migrasi DOIT recurring; migrasi kerja 0500, preflight index unik)
4. `ghostex/ee902477` 132131605 (K akses/migrasi Tanya AI 964+976; migrasi kerja 0495, 0496). Menggantikan `ghostex/964-ws-12-tanya-ai-be-tersisa` (sudah termuat). JANGAN `ghostex/981-*` (batch85).
5. `ghostex/969-duitku-e-wallet-kartu-be` ad0507789 (K uang WS-05; di atas 940 yang sudah di m1; tanpa migrasi)
6. `ghostex/974-pos-laci-dan-harga-inklusif` 7b05fb24e (K uang/migrasi POS; migrasi kerja 0520)
7. `ghostex/recon-refund-parsial-provider` 9788dc422 (K uang/migrasi recon 967; di atas 958 yang sudah di m1; migrasi kerja 0505). JANGAN `ghostex/980-refund-sisa-4-kartu` (masih bekerja).
Batch85 (jangan sekarang): `ghostex/4badcac8`, `ghostex/978-*`, `ghostex/981-*`, `ghostex/982-*`. JANGAN `ws/edge-kds-stations`, `ghostex/5ce165c2`, `fix/e2e-m1-858`, `ghostex/duitku-fe-ws05`, `ghostex/pos-panel-bayar-sisa-5w6`.
Migrasi: nomori ulang berurutan dari 0443 sesuai urutan masuk lewat `scripts/migration-renumber.mjs`; registry dan referensi test ikut nomor baru; `db:generate` kosong; `check-journal` hijau tiap tahap.
Konflik: test cabang lain yang bertentangan dengan keputusan CTO di cabang masuk (955/972 offboarding 409, 974 held dipertahankan, 976 pph21RefundIdr di luar gross TL-05, 969 method_changed tidak dihitung percobaan) diubah ke keputusan itu, bukan dilonggarkan. Ragu di jalur uang: berhenti dan lapor.
Gate: fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`), text-contract, `tests/platform-*.test.mjs`, area payroll/doit-recurring/ai-tools/duitku/pos-cash/recon/refund, lalu lint, typecheck, e2e produksi, build, FULL RUN wajib (uang + akses + migrasi). Satu job heavy sekaligus per thread (TEAM #14): full run dan e2e mock BERURUTAN. Cek `ram-guard status` sebelum typecheck dan full run. Tunggu job latar dengan satu Monitor yang memicu hanya saat selesai/gagal (tanpa tick); bila tidak ada proses test yang jalan, baca log, jangan menunggu.
e2e mock: baseline batch83 = 2 gagal (legend-g6d AUTH-05, TEN-03). Hanya kegagalan baru di luar baseline yang menahan.
Gagal karena koneksi DB (`Connection terminated unexpectedly`, `57P03`, `in recovery mode`): rerun terarah berkas itu, catat jumlahnya.
Paralel: pakai subagent untuk pekerjaan yang tidak saling menunggu (Explore cek konflik/ancestry per cabang sebelum menyusun, test-runner membaca log panjang, reviewer untuk resolusi konflik di jalur uang).
Setelah mendarat: tutup kartu yang semua AC-nya selesai (cek `bd show`), komentari SHA m1. Hapus worktree dan cabang int, `cleanup-ssd --repo` laporan (apply bila disk < 30 GB, tahan worktree thread yang masih bekerja). Volume Docker bernama JANGAN dihapus. Edit `docs/merge-queue.md` di folder utama tanpa commit. PROGRESS batch84 ke m1.
Laporan: SHA m1, cabang masuk, peta nomor migrasi lama -> baru, gate per tahap (durasi), kartu ditutup, angka subagent (total, puncak, pemegang heavy). Lapor sekali di akhir.
