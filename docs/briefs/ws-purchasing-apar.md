# Brief bersama: ws/purchasing-apar (WS-06/07, tingkat K uang + migrasi)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-4ab2085c`, cabang `ws/purchasing-apar` (dari `origin/milestone/m1`).
Semua perintah dimulai dengan `cd` ke root worktree itu. Jangan sentuh payroll, kas bank, settlement, QRIS.

## Kartu
- A `legend-lspfy`: faktur pemasok (supplier invoice) + 3-way match PO / goods receipt / faktur, memanggil
  `recordSupplierInvoicePayableInTransaction` (`apps/api/src/services/accounting-ap.service.ts:57`) dan posting rule
  (`apps/api/src/services/.../posting-rules.ts:353`). PPN/PPh23.
- B `legend-nz13`: toleransi 3-way match per tenant (basis point), endpoint setting tenant (baca + ubah).
- C `legend-uyk2`: purchasing memanggil fungsi AP di transaksi DB yang sama; tidak dobel buku (aset tetap hanya
  dari `sourceDocumentId`, jangan juga lewat `supplier_invoice.recorded`). Bagian AR: hanya bila ada pemanggil nyata.
- D `legend-179bw`: nota debit retur (`purchase-return.service.ts`) yang sudah ditagih membuat open item AP (mengurangi
  utang tepat sekali, idempoten).
- E `legend-a5wl`: registry deep-link jurnal source-type → route web (ACC-03), hanya untuk layar yang sudah ada.
- F `legend-xysyi`: XML Coretax (`accounting-coretax-xml.ts`) memakai NPWP asli (dekripsi saat ekspor) + format.

## Migrasi
Hanya nomor `0490` dan `0491` (`apps/api/drizzle/0490_*.sql`). Setelah selesai `pnpm db:generate` harus kosong.
Jangan menulis ulang migrasi lama.

## Aturan uang (founder, wajib test gagal-dulu)
1. Faktur yang melebihi PO/penerimaan di luar toleransi ditolak atau ditahan (status hold), pemasok tidak dibayar lebih.
2. Debit note mengurangi utang tepat sekali (ulang/idempoten tidak mengurangi lagi).
3. Posting AP/AR gagal = transaksi purchasing batal (rollback penuh, tidak setengah tercatat).
4. Tenant lain ditolak (404/403, tidak bocor).
Ragu: pilih aturan yang membatasi pembayaran, catat di laporan.

## Aturan kerja
- Test terarah dari ROOT worktree: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test`. Hanya SATU subagent
  yang memegang token heavy (vitest/tsc) sekaligus; yang lain baca/edit saja. Pemegang token: diumumkan engineer.
- ID brand (`TenantId` dll.): pakai helper konstruktor proyek, bukan `as`.
- Lint/format file berubah: `pnpm exec eslint <file>` + `pnpm exec prettier --check <file>`.
- Jangan commit; engineer yang commit.

## Desain
Desain architect ditulis di `docs/briefs/ws-purchasing-apar-design.md` (bacalah bila ada).
