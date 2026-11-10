# 196b hasil architect (second opinion pengganti Codex) — legend-nhmct

Tanggal: 9 Nov 2026. Read-only.

## Rentang yang diperiksa
- Cabang belum masuk `milestone/m1` (tidak ada merge di m1 untuk `ws/receipt-gaps-prefix`).
- Diperiksa: `rebase/receipt-gaps-prefix` 11f44e90 (base m1 9b681bea, batch21). `git range-diff` dengan `ws/receipt-gaps-prefix` 4087b661: patch identik.
- Berkas: `pos-receipt.service.ts` (`receiptGapsForDevice` baris 1661-1690, `receiptGapsOfRun`), `pos-shift-ports.ts`, `pos-shift.service.ts` (`getPosShiftReport` 332-376), `pos-day.service.ts` 761-768, `packages/shared/src/pos/schemas.ts` (`posReceiptGapRunSchema`).

## Jawaban per invariant
- Dua run, nomor hilang sama: satu entri per baris `receipt_sequences`, urut `createdAt, id`, prefix masing-masing. Tidak digabung. Lulus.
- Run `edge_regressed`: `lost = lastNumber+1..edgeReportedNumber` hanya bila `edgeReportedNumber > lastNumber`. `formatReceiptNumber` tidak bisa melempar: CHECK DB `edge_reported_number BETWEEN 0 AND 999999999` sama dengan `RECEIPT_MAX_ORDINAL`. Lulus.
- Rentang hilang tidak menahan Tutup Hari: `pos-day.service.ts:767` hanya menolak bila `run.missing.length > 0`. Lulus.
- Perangkat satu run tanpa celah: entri hanya dibuat bila ada `missing` atau `lost`, jadi hasil `[]`. Lulus.
- TEN-01/02: query difilter `tenantId + outletId + deviceId`, join receipt pakai `tenantId + sequenceId`, di dalam `withTenant` (RLS). `outletId` dan `deviceId` berasal dari shift yang sudah lolos `findShift` + `assertCanRead`. Lulus.
- Konsumen skema: `receiptGaps` hanya dipakai API dan mock web (`[]`). Tidak ada UI yang masih membaca `number[]`. Lulus.

## Temuan
Tidak ada P1/P2. **Bersih.**

## Catatan P3 (tanpa kartu)
- `pos-receipt.service.ts:1682`: `lost` hanya untuk `edge_regressed`. Run `claim_rotated`/`edge_replaced` dengan `edgeReportedNumber > lastNumber` tidak menampilkan rentang. Ini sesuai spesifikasi, karena run pensiun masih bisa di-merge terlambat (zsdd/ol6v). Catat bila kelak perlu rekonsiliasi.
- `getPosShiftReport`: run dengan banyak nomor hilang menghasilkan array string besar tanpa batas. Masalah ini sudah ada sebelumnya, karena `number[]` juga tanpa batas. Dalam praktik kecil, sebab `lastNumber` hanya naik lewat merge lengkap.
