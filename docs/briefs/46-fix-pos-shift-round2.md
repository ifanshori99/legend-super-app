# Brief: fix putaran 2 — ws/pos-shift (temuan second-opinion Codex)

Cabang `ws/pos-shift` (HEAD 3e0855c), worktree `.worktrees/pos-shift`. Kartu legend-6c0. Uang: tiap fix butuh test regresi yang gagal sebelum fix (race diuji dengan dua transaksi DB bersamaan, bukan hanya urutan).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (file tidak bertumpuk). Pastikan `node_modules` worktree bukan symlink ke checkout utama (legend-meki): bila symlink, hapus lalu `pnpm install --offline --frozen-lockfile`. Merge `main` dulu (422 di platform tenants sudah diperbaiki di main, bukan urusanmu).

## Kerjakan
1. **P1 pos-day.service.ts:588** — setelah hari D ditutup, pesanan D masih bisa dibuat/dibayar/diselesaikan; rekap beku kehilangan penjualan. Fix: satu helper `assertBusinessDayOpen` + lock hari bersama, dipanggil di semua mutasi yang memengaruhi rekap (buat/submit/bayar/selesai/void/refund).
2. **P1 pos-shift.service.ts:739** — tender tunai tidak memakai lock shift; tender yang commit di tengah close hilang dari snapshot, dan tunai setelah shift tutup tetap diterima. Fix: tender/refund/void tunai terikat ke shift aktif dan mengambil lock shift yang sama dengan close sebelum menulis; close mengagregasi di bawah lock itu.
3. **P1 pos-shift.service.ts:732** — approval PHONE tidak terikat nilai variance (approval Rp0 menerima selisih Rp1.000.000). Fix: variance dihitung server, approval terikat nilai + fingerprint hitungan pecahan, tier matriks divalidasi saat dipakai.
4. **P2 pos-shift.service.ts:746** — pengajuan hitungan dibuang saat note belum ada; kasir bisa mengganti angka memakai approval yang sama. Fix: simpan pengajuan hitungan pertama secara immutable; angka berubah butuh approval baru; jejak semua pengajuan.
5. **P2 pos-day.service.ts:647** — cek shift terbuka hanya untuk tanggal yang ditutup; shift lintas cutoff 04.00 lolos. Fix: blokir tutup hari selama ada shift aktif di outlet yang relevan, termasuk shift lintas cutoff.

## Catatan konflik
Cabang lain sedang mengubah `pos-order-payment.ts`, `payment.service.ts` (ws/pos-payment-fixes) dan `pos-order.service.ts` (ws/kds). Di file itu cukup sisipkan panggilan helper satu-dua baris; logika lock taruh di pos-shift/pos-day service. Konflik dirapikan saat merge.

## Bukti selesai
Test terkait lulus, `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus, `git status` bersih, subagent reviewer konteks segar cek diff. Commit lokal merujuk legend-6c0. Jangan push, jangan merge. Lapor per temuan: fix, test, commit.
