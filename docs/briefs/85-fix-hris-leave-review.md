# Brief 85: fix review Opus — cuti HRIS (ws/hris-leave, dari 1db3cd05)

Peran: engineer. Worktree cabang `ws/hris-leave`. Kartu: legend-arj.1/.3/.4. Sumber: reviewer Opus 2026-11-08, PERLU FIX.

## Wajib dibetulkan
1. **Potong dua kali** (Tinggi) — `hris-leave-collective.service.ts:387-410`, `hris-holiday.service.ts:287,371`. Cuti 22-26 Des approved (used 5), lalu HR menambah cuti bersama 24 Des → job memotong 1 lagi (used 6). Fix: job melewati pasangan karyawan+tanggal yang tertutup `leave_requests` approved/pending; perbaiki komentar baris 22-24.
2. **Carry-over hangus masih terpakai** (Tinggi) — `hris-leave.service.ts:992`, `hris-leave-request.service.ts:782`. Saldo dengan pending > 0 dilewati job hangus, dan `available` tidak cek `carryOverExpiresOn`. Fix: setelah tanggal hangus, `available` mengeluarkan carry yang tak tertahan; job hangus tetap menghanguskan `carried − (used + pending)` walau pending > 0. Uji skenario 30 Mar/1 Apr/2 Apr dari review.
3. **Potongan cuti bersama tidak dibalik** (Sedang, legend-ei32) — `hris-holiday.service.ts:371,443-453`. Hapus/geser/ubah tipe hari cuti bersama yang sudah dipotong → balik ledger `collective_leave` dan `usedDays` (idempoten, diaudit). Bead legend-ei32 ditutup di sini.
4. **Cuti bersama mundur menggelembungkan carry** (Sedang) — `hris-leave-collective.service.ts:301,317-328`. Tolak membuat/menggeser cuti bersama ke tahun yang carry-over-nya sudah dijalankan (422, kode error baru), kecuali kamu bisa mengoreksi carry tahun berikut dengan aman di transaksi yang sama.
5. **Migration** — merge `milestone/m1` ke cabang ini, lalu ikuti "Catatan merge milestone" di `docs/PROGRESS.md`: buang migration cabang 0063–0068 + snapshot + entri journal, `pnpm db:generate` ulang, SQL custom (RLS/trigger) ke migration `--custom` baru; semua `when` > journal milestone terakhir. Tutup legend-fgob.

## Tidak dikerjakan di sini (sudah kartu)
legend-0pth (pemakaian silang id upload), legend-2ect (signer storage router), legend-qmte (absensi).

## Bukti selesai
Test regresi untuk 1-4; migrate lulus di DB kosong dan DB di milestone/m1 head; gate penuh (format, color, tenant-hardcode, `heavy pnpm check`, `heavy pnpm build`); reviewer konteks segar atas diff fix; commit lokal, jangan push. Laporan: SHA, test, migration lama→baru dengan `when`.
