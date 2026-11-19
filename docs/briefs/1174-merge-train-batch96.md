# 1174 Merge train batch96
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Sonnet 5.5 high. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore ancestry/konflik per cabang, test-runner untuk log panjang). Tidak ke `main`, tidak deploy, tidak force push.
Basis: `origin/milestone/m1` sesudah batch95 mendarat (catat SHA dan migrasi ujung). `git fetch` dan ambil tip terbaru tiap cabang; lewati yang sudah ancestor m1. Sumber kebenaran: `docs/merge-queue.md` (folder utama), baris terbaru tiap cabang menang.
Isi (urut, 7 cabang):
1. `ghostex/d158b041` 14e34d887 (K kas). Daftarkan gerbang rilis 1118 / legend-gwqjp di runner release-gates; legend-1tke7 mode info.
2. `ghostex/fix-so-approval-waktu` e1020c77e, lalu 3. `ws/1164-payout-recurring-approval` d9806d79d (K uang/akses + migrasi kerja 0706; memuat 2 dan cherry-pick 64d5d345e dari m1: konflik dengan m1 diselesaikan ke versi m1 untuk isi 64d5d345e).
4. `ws/1144-refund-hold-echo` d217d439d (K uang).
5. `ws/1095-void-refund-ganda-voucher` 4bfae8476, lalu 6. `ws/1169-refund-lr-riwayat` 6d0a53065 (K uang; 6 memuat 5).
7. `ghostex/member-qr-token-klien-1150` 3ad22a061 (K akses member QR).
JANGAN (batch97): `ghostex/eb4d9add`, `ghostex/1159-web-test-hygiene`, `ws/1162-pos-struk-edge`, `ws/1163-reservasi-slot-pickup`, `ws/1167-*`, `ws/1172-*`, `ws/1165-*` (menunggu gerbang UI founder).
Migrasi: nomori ulang berurutan dari ujung m1 + 1 lewat `scripts/migration-renumber.mjs`; registry dan referensi test ikut; `db:generate` kosong; `check-journal` hijau tiap tahap.
Konflik di jalur uang/akses: ikuti keputusan CTO di cabang masuk (lihat baris merge-queue tiap cabang), jangan longgarkan test. Area refund (4, 5, 6) menyentuh `payment-webhook.service.ts`, `order-given.ts`, `pos-order-corrections.ts`: gabung, jangan buang guard salah satu sisi. Ragu: berhenti dan lapor.
Gate: links, lint, typecheck, fast gate (kontrak pemindai, text-contract, `tests/platform-*.test.mjs`, area kas/refund/payout/approval/member), build, e2e produksi, lalu FULL RUN SATU KALI dan SENDIRIAN (cek `heavy --status`). Tunggu dengan Bash run_in_background (notifikasi saat exit), bukan Monitor pendek. Baseline flake bernama (tidak menahan): ORD-03 `tax-api`, rbac-audit-writer 'audit writer failed after appending', legend-uwafm, MRF-J1 timeout di bawah beban. Kegagalan lain menahan. Gagal koneksi DB: rerun terarah berkas itu.
Setelah mendarat: tutup bead yang AC-nya selesai, komentari SHA m1. Hapus worktree dan cabang int. Edit `docs/merge-queue.md` dan PROGRESS di folder utama.
Laporan: SHA m1, cabang masuk, peta migrasi lama -> baru, gate per tahap (durasi), bead ditutup, `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
