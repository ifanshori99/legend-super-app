# Second opinion 1160 — waktu approval ronde 2

Target sesudah `git fetch origin`: `origin/ghostex/fix-so-approval-waktu` = `e1020c77e2109c58f3c2d0a7a2657aa90df533c7`. Diff: `bf1567dec..e1020c77e -- apps/api packages/shared` (5 berkas; tidak ada perubahan `packages/shared`). Semua rujukan kode di bawah memakai nomor baris target. Laporan ronde 1 dibaca dari `docs/qa/second-opinion-approval-waktu-1148.md` di folder utama karena tidak ada dalam commit target.

Hasil: P1 dan P2 ronde 1 tertutup secara statis. Tidak ditemukan regresi baru pada keputusan approval dalam diff 1151. Ada satu P2 sisa pada jalur pembatalan di layanan yang sama; kode ini sudah ada sebelum diff 1151.

## Temuan

- **P2 — `apps/api/src/services/platform-approval.service.ts:807`: Pembatalan requester masih bisa melewati tenggat karena resolver memakai jam sebelum lock.** `resolveApprovalChainOutcome` menunggu `lockChain` pada 802, tetapi membandingkan deadline dengan `input.now` lama. Jalur HTTP nyata `POST /api/approvals/:requestId/cancel` (`apps/api/src/routes/platform-approval.routes.ts:110`) memanggil `cancelOwnApprovalRequest`, yang memotret waktu pada 906; `cancelOwnRequest` meneruskannya ke resolver pada 1030–1034 lalu membatalkan pada 1039–1045. **Skenario:** Koneksi B menahan `SELECT ... FOR UPDATE` pada chain-head; requester mulai cancel pada tenggat−1 detik; B melepas lock pada tenggat+1 detik tanpa mengubah status. Resolver masih mengembalikan `pending`; pembatalan sukses dengan status/event `cancelled`, padahal aturan 899–900 dan 1028–1029 mengharuskan konflik untuk permintaan kedaluwarsa. Jalur POS melalui `cancelOwnModuleApprovalRequest` juga memakai helper ini. **Perbaikan:** Segarkan waktu sesudah chain lock dengan maksimum jam pemanggil dan jam server, lalu pakai waktu itu pada evaluasi tenggat dan fakta transisi. **Usul test:** Dua koneksi dengan barrier memastikan cancel benar-benar menunggu chain-head sebelum tenggat; lepaskan sesudah tenggat tanpa UPDATE. Harapkan HTTP 409 `CONFLICT`, tanpa status/event `cancelled`; sesudah rollback, sweep boleh menerbitkan satu hasil `expired`. Tambahkan kontrol pelepasan sebelum tenggat yang tetap berhasil. Penundaan ini terjadi sebelum pemeriksaan deadline, sehingga berbeda dari pengecualian CTO mengenai UPDATE yang menunggu sweep sesudah waktu cek.

## Penutupan ronde 1

- **P1 tertutup:** `apps/api/src/services/platform-approval.service.ts:1461` selalu membaca `Date.now()`, kemudian 1463–1464 memilih maksimum jam tersebut, jam pemanggil, dan waktu fakta refund. Waktu lama dari pekerjaan pemanggil sebelum masuk core tidak lagi bisa memundurkan pemeriksaan. Test baru `apps/api/src/test/platform-approval-caller-now-stale.test.ts:306`, 318, 330, 363, dan 389 mencakup approve/reject terlambat, izin yang habis, keputusan tepat waktu dengan jam lama, serta jam pemanggil yang lebih akhir.
- **P2 tertutup:** Pemanggilan `lockAndCheckSoleOwnerSelfApproval` pada `apps/api/src/services/platform-approval.service.ts:1449` selesai sebelum jam dibaca pada 1461. Test baru `apps/api/src/test/platform-approval-sole-owner-lock-time.test.ts:388` menahan advisory lock tenant sampai lewat tenggat dan mengharapkan `APPROVAL_REQUEST_EXPIRED`, tanpa keputusan, audit keputusan, atau event resolved. Kontrol tepat waktu pada 418 memeriksa keberhasilan dan timestamp sesudah lock dilepas.

## Pemeriksaan pemanggil dan invariant

- Cuti, koreksi absensi, dan stok opname meneruskan jam yang sudah diambil sebelumnya; maksimum jam server pada core kini menutup pola itu. Lembur dan `payment-refund.service.ts:1638` tidak meneruskan `options.now`. Tidak ditemukan jalur tambahan yang menerima keputusan terlambat atau menolak keputusan tepat waktu akibat diff ini.
- Payout gaji memakai jalur terpisah `approveDisbursementBatch` pada `payroll-payout.service.ts:1653`, tanpa memanggil `decideApprovalRequest`; perubahan ini tidak mengubah jalur tersebut. Ini bukan audit ulang seluruh implementasi payout.
- Lifecycle, matriks izin, dan snapshot akses memakai `checkAt` pada `platform-approval.service.ts:1476`, 1485, 1507, dan 1531. Keputusan disimpan dengan `decidedAt = checkAt` pada 1466 dan 1556; event keputusan/resolved memakai waktu yang sama pada 1575 dan 1639.
- Level berikut memakai `checkAt` untuk `createdAt`, `updatedAt`, dan basis `deadlineAt` pada `platform-approval.service.ts:1618`. Pemeriksaan limit refund sesudah waktu cek hanya membaca data, tanpa lock baris/advisory tambahan.
- Route mengambil tenant/user dari konteks terverifikasi; schema keputusan tidak menerima jam HTTP. Scope RLS dan filter tenant refund tetap berlaku. Tidak ditemukan celah lintas tenant tambahan dalam area yang ditinjau. Pengecualian yang telah diterima CTO tidak dilaporkan ulang.

## Verifikasi dan batas

- Review statis memakai `git diff`/`git show`/`git grep` dari folder utama, tanpa checkout atau worktree. Tiga subagent read-only, puncak tiga bersamaan; parent memeriksa ulang alur temuan pembatalan dan penutupan ronde 1.
- Tidak menjalankan test PostgreSQL, unit/integration test, build, atau typecheck. Test yang disebut di atas diperiksa sumbernya, bukan diklaim lulus pada sesi ini; skenario P2 belum direproduksi runtime.
- `pnpm exec prettier --check docs/qa/second-opinion-approval-waktu-r2-1160.md` tidak dapat menjalankan formatter: `node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Format Prettier belum terverifikasi; dependensi tidak dipasang untuk review read-only ini.
- Coverage tambahan yang berguna, bukan temuan: fakta refund lebih akhir daripada kedua jam lain; kesamaan persis `next.createdAt = decidedAt` dan `next.deadlineAt = next.createdAt + durasi`; barrier pada transaksi stok opname/koreksi absensi nyata sebelum masuk core.
- Hanya laporan ini yang ditulis. Tidak ada perubahan kode, commit, push, atau merge; status Beads tetap ditangani CTO.
