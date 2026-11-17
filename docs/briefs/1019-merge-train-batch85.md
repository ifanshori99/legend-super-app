# 1019 Merge train batch85
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` a981c1a53 (batch84, migrasi ujung 0449, journal `when` terakhir 1795000000064). `git fetch` dan ambil tip terbaru tiap cabang sebelum menyusun; lewati yang sudah ancestor m1.
Isi (urut, maks 7; detail tiap cabang di `docs/merge-queue.md` folder utama):
1. `ghostex/4badcac8` cf9428b5a (S tooling legend-1ek1l)
2. `ghostex/978-edge-ketahanan-katalog-purge-pin` fed38a6a9 (K akses edge)
3. `ghostex/980-refund-sisa-4-kartu` 08187d8b0 (K uang/migrasi)
4. `ghostex/982-charge-tukar-menu-refund-void-pos` 2ba47d846 (K uang, sesudah 980)
5. `ghostex/a846fbcc` c9c096052 (K uang/migrasi/akses 983)
6. `ghostex/981-ulasan-ai-11-modul-mcp` 83dd3da01 (K migrasi+akses+PII)
7. `ghostex/984-akses-outlet-asing-perangkat` e35c4a41a (K akses, sesudah 981)
Batch86 (jangan sekarang): semua entri "SIAP batch86" di merge-queue, termasuk `ghostex/984-f586w-shared-device-wip`, 985, 994, 990, 1001-1018.
Migrasi: nomori ulang berurutan dari 0450 sesuai urutan masuk lewat `scripts/migration-renumber.mjs`; `when` naik dari 1795000000065; registry dan referensi test ikut nomor baru; `db:generate` kosong; `check-journal` hijau tiap tahap.
Konflik: keputusan CTO yang ada di cabang dipertahankan (lihat merge-queue). Test cabang lain yang bertentangan disesuaikan ke keputusan, jangan dilonggarkan. Uang: bila ragu, pilih yang membatasi dan laporkan.
Gate: fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`), text-contract, `tests/platform-*.test.mjs`, area refund/charge/void/POS/edge/ai-tools/akses perangkat. Lalu lint, typecheck, build, full run, e2e produksi, e2e mock.
Retro 42: bekukan int/batch85 selama full run; perbaikan hanya setelah run selesai, rerun berkas yang gagal saja, lalu satu full run akhir.
e2e mock: baseline batch84 = 2 gagal (legend-g6d AUTH-05, TEN-03); OPS-04/05 (legend-cz9g) dan "Ya, masuk" (legend-kmndq) flake beban, rerun terisolasi sebelum menahan.
Gagal koneksi DB (`Connection terminated unexpectedly`, `57P03`, `in recovery mode`): rerun terarah berkas itu, catat jumlahnya.
Paralel: subagent untuk kerja yang tidak saling menunggu (Explore cek konflik/ancestry per cabang, test-runner membaca log panjang, reviewer satu kali untuk hunk konflik di jalur uang/akses).
Setelah mendarat: tutup kartu yang semua AC-nya selesai (cek `bd show`), komentari SHA m1. Hapus worktree dan cabang int, `cleanup-ssd --repo` laporan (apply bila disk < 30 GB, tahan worktree int/* dan thread yang masih bekerja). Edit `docs/merge-queue.md` folder utama lalu commit sendiri di cabang folder utama.
Laporan: SHA m1, cabang masuk, peta nomor migrasi lama -> baru, gate per tahap (durasi), kartu ditutup, angka subagent (total, puncak, pemegang heavy). Lapor sekali di akhir (Monitor, bukan sleep loop).
