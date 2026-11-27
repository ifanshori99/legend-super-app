# C4b progres (legend-osqou.8)

## Sudah

- Kontrak `listSettlements` (GET `/reconciliation/settlements`, outletId wajib, filter source/provider/periodFrom/periodTo, cursor) + DTO `settlementListItemSchema` di `packages/shared/src/payment/admin.ts`.
- Test gagal-dulu `apps/api/src/test/payment-settlement-list.test.ts` (7 gagal: route belum ada). Commit 0a091dce8.
- Langkah 1 selesai: service `listSettlements` (`payment-settlement-import.service.ts`) + route GET (`payment-admin.routes.ts`, `reconcileQuery`). Test terarah 7/7 lulus, prettier/eslint bersih, typecheck api hijau.

## Sedang

- Typecheck web hijau. Langkah 2-4 menunggu keputusan di bawah (panel rekonsiliasi juga belum punya pemilih outlet, sedangkan daftar butuh outletId).

## Perlu keputusan CTO (langkah 2)

1. Format berkas: impor C4a menerima JSON baris (reference, amountIdr, feeIdr + total), bukan berkas. Pola X2 = server mengurai CSV. Untuk Duitku tidak ada parser dan format ekspor Duitku belum terdokumentasi di repo. Pilihan: (a) endpoint server baru pengurai CSV Duitku (butuh contoh berkas asli), (b) templat CSV milik kita diurai di browser (angka uang dari klien, bertentangan dengan "semua angka uang dari server").
2. MFA: `importSettlement` server tidak memeriksa faktor kedua. Step-up di layar hanya hiasan kecuali server menolak dengan `MFA_REQUIRED` (mengubah perilaku C4a, test impor yang ada perlu sesi MFA; helper test sudah memverifikasi MFA).

## Berikut

- Langkah 3 (panel rekonsiliasi: daftar settlement terakhir, hapus cabang 503) bisa jalan setelah langkah 1.
