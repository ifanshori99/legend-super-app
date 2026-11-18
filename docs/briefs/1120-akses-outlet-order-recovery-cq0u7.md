# 1120 Outlet token kasir di waive/expire charge dan order-recovery (legend-cq0u7, tingkat K akses)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore semua route order-recovery*, test-writer kasir dua-outlet, implementer middleware).
Base: `ws/1094-akses-perangkat-bersama-sisa` (head f3a6ced98, belum landing). Cabang baru `ws/1120-akses-outlet-order-recovery`. Push tanpa `--force`. Tanpa migrasi.

## Isi (bead legend-cq0u7)
Kasir dengan token outlet A (bertugas di A dan B) bisa waive/expire charge dan report/resolve order-recovery milik outlet B: `order-recovery-charge.routes.ts:51`, `order-recovery.routes.ts:59,78` (nomor baris di m1; cek ulang di base).
Keputusan CTO (membatasi): satu helper di `middleware/acting-staff.ts` (pindahkan pola `refuseOtherOutlet` dari `apology-voucher.routes.ts`) yang mencari outlet dari charge/item/issue/pesanan di server, lalu menolak 403 `ACTING_STAFF_OUTLET_MISMATCH` bila beda dengan outlet token. Pasang di SEMUA route order-recovery* yang memakai token kasir (grep, termasuk GET yang membuka data pesanan outlet lain). Sumber tidak ditemukan / ragu = tolak. Tanpa token kasir (login pribadi): perilaku tidak berubah. Pakai ulang helper itu di apology-voucher.

## Bukti
Test kasir dua-outlet per route: merah di base, hijau di head; login pribadi tetap lolos. Regresi test 1094 + order-recovery* + apology-voucher. Typecheck API sekali lewat heavy (heap 8 GB). Prettier/eslint. Architect xhigh delta sekali. `bd close legend-cq0u7` saat selesai.

## Laporan
Commit, head SHA, daftar route yang dijaga, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.

## Tambahan CTO (architect xhigh delta 1094, P1)
`apps/api/src/lib/shared-device-allowlist.ts:82` masih mengizinkan `POST /api/apology-vouchers` di perangkat bersama; `issueApologyVoucherForStaff` -> `settleIssueWithVoucher` (`apology-voucher.service.ts:936`) menerbitkan voucher dan me-resolve isu = jalan pintas resolve voucher yang sudah ditutup 403. Keputusan (membatasi): pindahkan `POST /api/apology-vouchers` ke DENY perangkat bersama untuk SEMUA bentuk (dengan atau tanpa `orderIssueId`), 403 `SHARED_DEVICE_SCREEN_CLOSED`. Grep route lain di allowlist yang menerbitkan nilai ke tamu (voucher, kredit, swap, refund, poin) dan tutup juga; laporkan daftarnya. Test: perangkat bersama -> 403, tidak ada baris voucher, isu tetap `open`; perangkat pribadi tetap lolos.
Catatan: cabang 1094 dan 1120 landing BERSAMA (1094 sendiri masih punya celah ini).
