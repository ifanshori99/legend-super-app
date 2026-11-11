# Brief subagent: WS-05 payment admin (516)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ws05-pay-admin` (cabang `ws/ws05-pay-admin`, basis `origin/milestone/m1`). Jangan sentuh checkout lain.
Uang, tingkat K. Aturan founder: tidak ada pihak dibayar lebih, outlet tidak rugi. Ragu: pilih aturan yang membatasi pembayaran, tulis pertanyaan, jangan menebak.
Migrasi baru hanya nomor 0328-0330 (cek `apps/api/drizzle/meta/_journal.json`). Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Hanya satu subagent menjalankan test/tsc pada satu waktu (yang ditunjuk engineer).

## Kartu

### A. legend-fuv7: endpoint admin routing rules + dana belum teralokasi + celah kontrak
- `listRoutingRules/upsertRoutingRule`, `listUnallocatedFunds/resolveUnallocatedFund` ada di server; pastikan ada `defineEndpoint` kontrak + route + wiring FE (`apps/web` fitur ws05-payment-admin, `api.ts`).
- `paymentRoutingSchema.outletId` harus nullable (default tenant = outlet_id NULL, PRD §3.13).
- `unallocatedFundsSchema` butuh `reason` dan `approvalRef` (PAY-04).
- Uang: dana belum teralokasi tidak bisa di-resolve/dialokasikan dua kali (termasuk dua koneksi paralel), idempotency key.

### B. legend-lnit: pengerasan akses admin pembayaran
1. Menonaktifkan terminal EDC harus clear atau blok default kasir yang menunjuk terminal itu.
2. Lookup default kasir wajib cek peran/permission kasir di outlet itu.
3. `apps/web/.../features/ws05-payment-admin/mock.ts` meniru API fail-closed untuk approve/credit refund.

### C. legend-7tc4: eksekusi refund + matriks approval
- Refund yang disetujui dieksekusi lewat adapter provider/manual, keputusan approval multi-level WS-01, idempotency, audit. PRD v1.7 §3.7, §3.13, PAY-04.
- Uang: refund tidak pernah melebihi yang dibayar (termasuk dua refund paralel di dua koneksi dan retry gateway), pembuat != penyetuju, batas nominal per level, idempotency di semua mutasi.

## Catatan
- Banyak test refund sudah ada (`apps/api/src/test/payment-refund-*.test.ts`, `payment-admin-*.test.ts`). Audit bd 9 Nov bilang "sebagian"; banyak yang mungkin sudah landing setelahnya. Cek dulu apa yang benar-benar kurang sebelum menulis.
- Service: `apps/api/src/services/payment-admin*.ts`, `payment-refund*.ts`, `payment-unallocated.service.ts`, `payment-routing.service.ts`. Kontrak: `packages/shared/src/payment/`.

## Hasil Explore (celah nyata)

A (fuv7):
- A1 `unallocatedFundsSchema` (`packages/shared/src/payment/index.ts:159-165`), `unallocatedFundViewSchema` (`admin.ts:386`), mapper `payment-admin-funds.service.ts:~134`, `payment-unallocated.service.ts:49-69`: tambah `reason` + `approvalRef` (kolom DB sudah ada `db/schema/payment.ts:358,365`). Resolve harus menulis `approvalRef`/`reason`; cek apa yang terjadi sekarang.
- A2 `paymentRoutingSchema.outletId` (`index.ts:143`) jadi nullable (default tenant).
- A3 Resolve dana dua kali paralel (dua koneksi, beda idempotency key) → tepat satu sukses, satu 409; total yang dialokasikan/di-refund dari dana <= nominal dana. Guard sekarang hanya di aplikasi (`payment-admin-funds.service.ts:207` FOR UPDATE).

B (lnit):
- B1 `updateEdcTerminal` (`payment-admin-config.service.ts:439-490`): nonaktif → hapus default kasir yang menunjuk terminal itu (dalam transaksi sama) + audit. `getEdcCashierDefaults` (`:517-550`) jangan kembalikan default ke terminal nonaktif.
- B2 Read (`:532-541`) dan write (`:553-600`) default kasir: wajib role assignment aktif (valid_from/valid_to) dengan permission kasir/POS di outlet itu (atau tenant scope). Cari nama permission kasir yang sudah ada di `packages/shared/src/permissions*`.
- B3 `apps/web/src/features/ws05-payment-admin/mock.ts:442-550`: tiru API fail-closed (approve tanpa chain/permission ditolak, tidak langsung `completed`, tidak ada credit).

C (7tc4):
- C1 Test: dua refund pada intent sama, dua koneksi paralel, jumlah keduanya > dibayar → total refund aktif <= dibayar (saat request DAN saat approval/eksekusi).
- C2 Test: retry gateway (port `payment-refund-gateway.ts`, fake adapter) timeout lalu retry → provider dipanggil dengan key `refund:${id}` yang sama, refund tidak terkirim dua kali, total <= dibayar.
- C3 Batas nominal per level/penyetuju: BELUM ADA, butuh keputusan founder. Jangan implementasi.

## Tugas test-writer

Test vitest API di `apps/api/src/test/`, pola seeding dari `payment-admin-api.test.ts` (`signedIn`, fixtures `cafeLegendPlatformFixtures`/`cafeLegendAccessFixtures`). Paralel = dua `Promise.all` dengan agent/koneksi terpisah. Gagal-dulu harus karena sebab yang benar (bukan 422/setup). Test yang sudah lulus di basis (bukti perilaku sudah benar) tetap dipertahankan, tandai di laporan.
- File 1 `payment-admin-ws05-fuv7.test.ts`: A1, A2, A3.
- File 2 `payment-admin-ws05-lnit.test.ts`: B1, B2.
- File 3 `payment-refund-ws05-race.test.ts`: C1, C2.
