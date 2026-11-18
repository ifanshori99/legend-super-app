# 1080 Merge train batch90
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Tidak ke `main`, tidak deploy, tidak force push. Worktree PENUH (jangan worktree-slim).
Basis: `origin/milestone/m1` 0b4fe006c (batch89, migrasi ujung 0479, journal `when` terakhir 1795000000096). `git fetch` dan ambil tip terbaru tiap cabang sebelum menyusun; lewati yang sudah ancestor m1.
Isi (urut, maks 7; detail tiap cabang di `docs/merge-queue.md` folder utama):
1. `ghostex/a99498c8` 73f2f3d72 (S nbkvh; dasarnya d8e5216b sudah di batch89)
2. `ghostex/1053-kas-gaji-tunai-guard-lock-order` 2f319094e (K uang; dasarnya b49350e5 sudah di batch89)
3. `ghostex/legend-tiw2h-recon-clearance-restriktif` 422ac1321 (K uang/migrasi; MENGGANTIKAN `1057-clearance-lembur-roster-runbook` dan `timeout-storage-dan-lock-recon`: jangan merge keduanya; 0674 diedit di tempat, jangan ambil 0674 dari cabang lama)
4. `ws/1073-edge-sweep-race` 053c8dc67 (K akses edge; memuat 1061 `ghostex/status-edge-ke-cloud-s1-s5` 3a5c4962c, migrasi kerja 0678-0679)
5. `ws/1073-edge-digest-cancel` 9cade8157 (K edge; memuat 80e75d2fc bawa-kai, migrasi kerja 0684)
6. `ws/1069-worktree-hemat` 916e08a6d (S tooling)
7. `ws/1078-kartu-kecil` 887e0f966 (S)
Batch91 (jangan sekarang): `ghostex/45769078` b8927ea90 (memuat 930b61c77), `ghostex/helper-tipe-id-bermerek-drizzle` 2797b55f4, `ghostex/1027-guard-http-perangkat-bersama`, dan entri SIAP lain.
Migrasi: nomori ulang berurutan dari 0480 sesuai urutan masuk lewat `scripts/migration-renumber.mjs`; `when` naik dari 1795000000097; registry dan referensi test ikut nomor baru; `db:generate` kosong; `check-journal` hijau tiap tahap.
Konflik: keputusan CTO yang ada di cabang dipertahankan (lihat merge-queue). Test cabang lain yang bertentangan disesuaikan ke keputusan, jangan dilonggarkan. Uang: bila ragu, pilih yang membatasi dan laporkan.
Gate: fast gate memuat test kontrak pemindai (`*-single-path*`, `*-contract*`, `*registry*`), text-contract, `tests/platform-*.test.mjs`, `tests/worktree-slim.test.mjs`, area payout/clearance/kas/edge. Lalu lint, typecheck, build, e2e produksi. Full run: wajib (batch menyentuh uang/migrasi); bekukan int/batch90 selama full run (Retro 42), perbaikan sesudah run, rerun berkas gagal saja. Kebijakan landing 14:24 (Retro 47/49): bila full run gagal hanya di berkas yang lulus terarah sesudah fix, landing boleh tanpa full run ulang; catat.
Flake dikenal: `provision-roles-audit.test.ts` (role klaster), `payroll-payout-897-proof-binding` 503, `rbac-audit-writer` ZodError, e2e mock legend-kmndq/9bh/azt. Gagal koneksi DB (`Connection terminated unexpectedly`, `57P03`): rerun terarah.
Sesudah e2e/visual: matikan dev server dan browser milik batch (Retro 49).
Paralel: subagent untuk kerja yang tidak saling menunggu (Explore cek konflik/ancestry per cabang, test-runner membaca log panjang, reviewer satu kali untuk hunk konflik di jalur uang/akses).
Setelah mendarat: tutup kartu yang semua AC-nya selesai (cek `bd show`), komentari SHA m1. Hapus worktree dan cabang int, `cleanup-ssd --repo` laporan. Edit `docs/merge-queue.md` folder utama lalu commit path-scoped di cabang folder utama.
Laporan: SHA m1, cabang masuk, peta nomor migrasi lama -> baru, gate per tahap (durasi), kartu ditutup, angka subagent (total, puncak, pemegang heavy). Lapor sekali di akhir (Monitor, bukan sleep loop).
