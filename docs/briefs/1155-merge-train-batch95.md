# 1155 Merge train batch95
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore ancestry/konflik per cabang, test-runner untuk log panjang). Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` 6b3288bc2 (batch94, migrasi ujung 0492). `git fetch` dan ambil tip terbaru tiap cabang; lewati yang sudah ancestor m1. Sumber kebenaran: `docs/merge-queue.md` (folder utama).
Isi (urut):
1. `ws/1094-akses-perangkat-bersama-sisa` f3a6ced98, 2. `ws/1120-akses-outlet-order-recovery` 6680b56cd, 3. `ws/1128-door-check-outlet-token` 1fa7fddea (K akses; tiga ini satu paket, SO akses 1133 bersih; 1094 HANYA bersama 1120).
4. `ws/1139-refund-ronde14-fix` 2c6dc862e (K uang + migrasi; sudah memuat ws/1072 [migrasi kerja 0696 refund_hold_invalid_report], ws/1126, ws/1135). Daftarkan gerbang rilis 26ro5 (hold refund lama) di runner release-gates saat landing.
5. `ws/1130-p2-pajak-sarapan-rekap` 86ed0ec32 (K uang sarapan; SO 1154 bersih).
6. `ws/1136-p3-web-mock-e2e` ed4e373c9 (S web).
7. `ws/1123-perf-web-i18n` 67423264f (S web i18n; bila bertabrakan dengan katalog 1136/1150, katalog digabung, bukan dibuang).
JANGAN: kas `ghostex/d158b041`/`ghostex/cek-kas-*`, `ws/1095-*`, `ghostex/ai-layar-approval-waktu-1137`, `ws/1144-*`, `ghostex/8b2dc0b1`. Batch96 (jangan sekarang): `ghostex/member-qr-token-klien-1150` 3ad22a061.
Migrasi: nomori ulang berurutan dari 0493 lewat `scripts/migration-renumber.mjs`; registry dan referensi test ikut; `db:generate` kosong; `check-journal` hijau tiap tahap.
Konflik di jalur uang/akses: ikuti keputusan CTO di cabang masuk, jangan longgarkan test. Ragu: berhenti dan lapor.
Gate: links, lint, typecheck, fast gate (kontrak pemindai, text-contract, `tests/platform-*.test.mjs`, area refund/akses/sarapan/i18n), build, e2e produksi, lalu FULL RUN SATU KALI dan SENDIRIAN (jangan bersamaan dengan full run lain; cek `heavy --status`). Baseline flake bernama (tidak menahan): ORD-03 `tax-api`, 'audit writer failed after appending' / rbac-audit-writer, legend-uwafm (911-closure-swap timeout). Kegagalan lain menahan. Gagal koneksi DB: rerun terarah berkas itu. Satu Monitor yang memicu hanya saat selesai; jangan lapor 'masih menunggu' (founder Q10).
Setelah mendarat: tutup bead yang AC-nya selesai, komentari SHA m1. Hapus worktree dan cabang int. Edit `docs/merge-queue.md` dan PROGRESS di folder utama.
Laporan: SHA m1, cabang masuk, peta migrasi lama -> baru, gate per tahap (durasi), bead ditutup, `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
