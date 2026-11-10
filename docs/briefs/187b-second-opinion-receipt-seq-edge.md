# Brief: second-opinion — nomor struk perangkat terikat ke satu database edge (legend-zsdd)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-seq-edge`, cabang `ws/receipt-seq-edge`.
Rentang diff: `git diff cc188ee0..ws/receipt-seq-edge` (base batch16 cc188ee0; abaikan `apps/api/drizzle/meta/*.json` dan `docs/`). Jangan pakai `merge-base main`.

## Berkas berisiko
- `apps/api/src/services/pos-receipt.service.ts` (claim, rotasi, ensureSequence, allocateReceipt, applyCloudDeviceReceiptSequence, mergeDeviceReceiptRun, receiptGapsForDevice)
- `apps/api/src/services/edge-device-sync.ts` (listDeviceRecordsSince, pull/apply)
- `apps/api/src/services/edge-node.service.ts` (`ensureLocalEdgeNode`, instance_id)
- `apps/api/src/edge/cloud-http.ts`, `apps/api/src/edge/runtime.ts`, `apps/api/src/edge/device-registry-puller.ts`
- `apps/api/src/db/schema/pos-receipt.ts`, `apps/api/src/db/schema/pos-receipt.custom.sql`, `apps/api/drizzle/0152_receipt_sequence_edge_binding.sql`
- `packages/shared/src/edge/schemas.ts`, `packages/shared/src/edge/endpoints.ts`

## Invariant (PRD)
- POS-06 / §3 F8: nomor struk berurutan tanpa celah per perangkat; satu nomor tidak pernah terbit dua kali di satu outlet; void tidak mengembalikan nomor.
- Satu counter urutan hidup di tepat satu database (cloud atau satu database edge). Edge dibangun ulang (node sama, database baru), standby yang mengambil alih, atau cloud yang melanjutkan setelah edge hilang tidak boleh menerbitkan ulang nomor edge lama yang belum sampai cloud (legend-ol6v belum ada).
- EDG-02: pull registri perangkat tidak boleh berhenti karena urutan struk (pencabutan perangkat tetap sampai).
- TEN-01/TEN-02: tenant dan outlet hanya dari kredensial edge yang terverifikasi.
- Rilis: cloud dulu; edge baru di cloud lama tetap menarik registri perangkat.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
