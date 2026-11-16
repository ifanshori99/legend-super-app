# 907 Merge train batch74
Peran: merge train (baca ~/.agents/team/roles/merge-train.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Basis: `origin/milestone/m1` 719171d33. Maks 7 cabang. Fast-forward m1, push tanpa force, jangan `main`.
0. Dulu: edit `/Users/ifanshori99/Projects/legend super app/legend/docs/merge-queue.md` (folder utama, cabang ux/customer-order-benchmark): hapus 7 entri batch73 yang sudah mendarat, tandai isi batch74. Jangan commit berkas itu; CTO yang commit.
Urutan depan (uang, penghalang rilis):
1. `fix/payout-so895-897` a06c6bdd4 (di atas 891 yang sudah mendarat; migrasi sementara 0637-0642 dinomori ulang mulai 0395; kartu p2v4s, klr99, v2dco). Test 900 membersihkan fixture gerbang global; test paralel satu DB bisa 409 PENDING.
2. `fix/qris-hold-so-879` 785b3b453 (memuat C1+C2/C3; migrasi 0381-0383 bentrok, nomori ulang; guard 409 `QRIS_HOLD_ACTIVE` di penulisan orders `qr-order.service.ts` m1, kartu legend-5ailc). Jangan merge `ghostex/775-qris-hold-c1` atau `ghostex/qris-hold-dp-c2-c3` terpisah.
3. `fix/seat-reservation-lock-order-f7rnw` 15b0933c7 (architect xhigh OK).
4. `fix/kecil-859` (migrasi 0448 dinomori ulang).
5-7. Sisanya dari urutan prioritas `docs/merge-queue.md` yang tidak tumpang tindih.
Catatan: cabang aktif `fix/payout-trusted-boundary-905` (dari payout-so895-897) dan `fix/va-staff-exit-5wn1e` (dari qris-hold-so-879) jangan digabung batch ini.
Gate seperti batch73 (lint, typecheck, check-journal, db:generate, kontrak root, API penuh sekali, e2e, test uang di tip akhir). Setelah mendarat: tutup kartu cabang yang masuk (QRIS: ad95t, xg6qk, 5h8ob, o6q8i, la1yk, yhia9.2/.3/.4, zff37, ota0l, w0ows, 9ho2v, kf104, eqeu7, 5ailc; payout: p2v4s, klr99, v2dco), hapus worktree int.
Laporan: tip m1, cabang masuk, peta nomor migrasi, hasil gate, angka subagent.
