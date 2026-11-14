# 796 Bukti fasilitas: ikat media ke jenis sumber dan pengunggah (legend-mg2bz, tingkat K)

Cabang `fix/facility-evidence-bind-source`. Jangan sentuh `canReadLeave` atau `linkStorageObjectSource`.

## Aturan

Media yang dilampirkan ke dokumen fasilitas harus: sourceKind sama persis dengan jenis dokumen
(checklist -> `checklist_evidence`, tiket perawatan -> `maintenance_ticket`), diunggah oleh aktor yang
sama (`uploadedBy` dan `ownerUserId` = aktor), tersimpan di outlet dokumen, dan belum terlampir ke
dokumen lain (`sourceId` null, atau sudah = dokumen ini sendiri, mis. jawaban checklist dikoreksi).
Gagal: 422 `VALIDATION_ERROR` (pesan generik, id tidak bisa dicoba-coba). Setelah dokumen tersimpan,
media ditandai terlampir (`sourceId` = id dokumen) di transaksi yang sama.

## Sudah ada

`apps/api/src/services/facility-evidence-media.ts` (sudah ditulis, jangan ubah tanpa lapor):

- `assertFacilityEvidenceBindable(tx, {tenantId, outletId, actorUserId, sourceKind, sourceId?, mediaIds, message})`
- `linkFacilityEvidence(tx, {tenantId, outletId, actorUserId, sourceKind, sourceId, mediaIds})`

## Potongan

1. Checklist: `operations-checklist.service.ts`. Ganti `assertEvidenceInOutlet` (~354) dan pemakaiannya
   (~817, jawaban butir). `sourceId` = `run.id`, `sourceKind` = `checklist_evidence`, aktor = `actor`.
   Setelah update `opsChecklistRuns` berhasil, `linkFacilityEvidence`. Foto + tanda tangan sama-sama media.
2. Peralatan: `operations-equipment.service.ts`. Ganti `assertTicketMediaInOutlet` (~341) dan pemakaiannya di
   `createMaintenanceTicket` (~1314). Pre-check di tempat lama (tanpa `sourceId`), `linkFacilityEvidence`
   dengan `sourceId` = `ticket.id` tepat setelah insert tiket. `sourceKind` = `maintenance_ticket`.
3. Cleaning: tidak ada jalur lampir media (diperiksa). Tidak perlu diubah.

## Test (test-writer, gagal-dulu)

Setiap file test punya helper `storedMedia(outletId)` yang menyisipkan baris `core_storage_objects` mentah
tanpa sourceKind/uploadedBy/ownerUserId: ubah jadi menerima `{ sourceKind, actorUserId }` (default
sourceKind sesuai jenis, uploader = aktor test). Tambah per layanan: foto orang lain (uploader beda,
outlet sama) ditolak 422; sourceKind salah ditolak; sudah terlampir ke dokumen lain ditolak; foto sendiri
sourceKind benar boleh dan baris jadi `source_id` = dokumen; (checklist) jawab ulang dengan foto yang sama
boleh. Jalankan: `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` dari root worktree.
Pastikan test lain di file yang sama tetap hijau.
