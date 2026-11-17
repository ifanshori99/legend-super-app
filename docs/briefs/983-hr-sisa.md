# 983 HR sisa (brief bersama)

Cabang kerja: worktree ini (dasar origin/ghostex/dd932307, payroll 955+972). Migrasi baru nomor 0555-0559 (0461, 0515 dipegang dd932307). Jangan sentuh: refund/recon (980), ulasan/MCP (981), charge tukar menu (982), aturan pencairan gaji 947.

Aturan: jangan sampai rugi. Bila ragu, tahan pembayaran untuk review manual. Offboarding: 409 saat potongan pending; pencairan pinjaman ditolak selama offboarding open/revoked/completed (keputusan CTO 955/972).

## Kartu A legend-i848k (backfill piutang PPh21)
Piutang karyawan yang dibuat sebelum open item 972 tidak punya item (`payroll-pph21-receivable-open-items.service.ts`, migrasi 0515). Backfill item lewat migrasi data: idempoten (dua kali jalan = sama), cek data bentrok dulu, nilai item = sisa piutang sebenarnya (mis. `pph21ReceivableOpenAfterIdr` slip terakhir), tidak boleh lebih. Bukti test: tidak lebih besar dari sisa; aman dua kali.

## Kartu B legend-qu04u (lampiran cuti)
`hris-leave-request.service.ts` `presentRequest` (~baris 520-560). Fix f161bcca7 sudah ada di HEAD (cek self.leave.request aktif di outlet cuti atau hr.leave.approve di outlet). Verifikasi tidak ada celah lain (tenant, karyawan lain, list vs detail) dan tambah test lintas tenant + lintas karyawan lewat router leave bila belum ada.

## Kartu C legend-72nod (rapel lembur)
Rapel hanya komponen tetap; koreksi lembur periode beku ditahan manual. Buat alur otomatis terbatas: selisih lembur yang disetujui masuk rapel periode berjalan; tidak pernah dobel dengan bayaran lama (termasuk koreksi berulang); selisih negatif jadi potongan bertahap (bukan diabaikan); karyawan offboarding tidak menerima rapel di luar aturan; aturan bayar terbatas tetap.

## Bukti test wajib
1. Backfill tidak > sisa, idempoten. 2. Rapel lembur tidak membayar dua kali jam yang sama, termasuk koreksi berulang. 3. Offboarding tidak terima rapel di luar aturan. 4. Lampiran cuti tidak bocor antar karyawan/tenant.

Test: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Satu token heavy per thread: hanya yang diberi tugas menjalankan tsc/vitest.

## Rancangan Kartu C (keputusan engineer; review architect xhigh)

Fakta kode: lembur dihitung live di `computeEmployeeGrossInTransaction` (payroll-components.service.ts ~1027-1190) dari `overtimeRequests` approved per periode (cap kehadiran + 720 mnt/hari, formula dipin). Baris slip `LEMBUR` tanpa ID request. Tidak ada kolom cancelledAt (`updatedAt`; cancel terminal). Transisi: pending->approve/reject/cancel, approved->cancel. Tidak ada cek periode terkunci. Rapel lama (payroll-rapel.service.ts) komponen tetap saja, selisih negatif ditolak.

Selisih periode beku (per karyawan, per run sumber S yang locked, tidak reversed, entitas sama, periode sebelum run target T):
- paidSet = request yang approved dengan decidedAt <= S.lockedAt (status approved, ATAU cancelled dengan updatedAt > S.lockedAt). currentSet = status approved sekarang.
- delta = f(currentSet) - f(paidSet), f = hitung lembur (ekstrak helper dari computeEmployeeGrossInTransaction yang menerima himpunan request + periode; basis gaji sama untuk kedua sisi, jadi perubahan basis/rapel gaji tidak ikut).
- Anti dobel: ledger `payroll_overtime_corrections` (tenant, employee, sourceRunId, targetRunId, direction, amountIdr, status settled), outstanding = delta - sum(signed settled). Baris ledger ditulis hanya saat lock T (seperti `syncPph21ReceivableOpenItemsInTransaction`, payroll-run-lock.service.ts:740), dibalik saat reversal (payroll-run-reversal.service.ts:723). Lock memeriksa ulang outstanding di bawah kunci; baris slip > outstanding: konflik 409 (tolak, jangan bayar lebih).
- Positif: baris earning `LEMBUR_KOREKSI` (taxable) di slip T, jumlah = min(outstanding positif). Tidak pernah dibayar dua kali jam yang sama; koreksi berulang aman karena outstanding memakai total.
- Negatif: baris deduction `LEMBUR_KOREKSI_POTONGAN` di slip T, bertahap: min(outstanding, total LEMBUR slip S yang terbayar, sisa gaji sesuai cap seperti penyerapan piutang PPh21 di payroll-run-compose.ts). Sisanya tetap outstanding untuk run berikut. Tidak pernah diabaikan.
- Tahan (tidak otomatis, dilaporkan `held`): karyawan dengan offboarding open/revoked/completed atau endDate sebelum akhir periode T; request tanpa formula/tanpa kehadiran jelas; run sumber tak terbaca. Bila ragu: tahan.
- Jangan sentuh aturan pencairan gaji 947 dan kasbon.
