# Cek produksi: jendela m1 tanpa audit writer di worker (legend-j88cz)

Latar: sebelum perbaikan, `worker-main.ts` tidak memasang audit writer. Setiap sapuan worker yang menulis audit lewat `services/audit-writer.ts` melempar `AuditUnavailableError` dan tidak berbuat apa-apa (dilog, dicoba lagi tiap tick). Akses tidak pernah terbuka: `assertSupportAccess` menolak izin yang sudah lewat `expires_at` tanpa menunggu sapuan. Yang hilang adalah catatan kedaluwarsa, audit, dan event.

Semua query di bawah hanya membaca. Jalankan dengan role pemilik (melewati RLS), atau per tenant dengan konteks tenant. Setelah deploy, sapuan akan menyusul sendiri: hitung dulu supaya burst notifikasi tidak mengejutkan.

## 1. Izin support access yang kedaluwarsa tapi belum dicatat

```sql
SELECT tenant_id, id, expires_at, now() - expires_at AS terlambat
FROM support_access_grants
WHERE ended_at IS NULL AND expiry_recorded_at IS NULL AND expires_at <= now()
ORDER BY expires_at;
```

Baris di sini: aksesnya sudah ditolak, tapi belum ada `expiry_recorded_at`, audit `support_access.expired`, dan event `support_access.ended`. Sapuan pertama sesudah deploy mengisinya (waktu catat lebih baru dari `expires_at`, itu wajar).

## 2. Permintaan support access yang masih pending lewat batas persetujuan

```sql
SELECT tenant_id, id, approval_expires_at
FROM support_access_requests
WHERE status = 'pending' AND approval_expires_at <= now()
ORDER BY approval_expires_at;
```

## 3. Persetujuan lewat tenggat yang belum kedaluwarsa (burst saat deploy)

```sql
SELECT tenant_id, count(*) AS jumlah, min(deadline_at) AS tertua
FROM approval_requests
WHERE status = 'pending' AND deadline_at <= now()
GROUP BY tenant_id ORDER BY jumlah DESC;
```

Setelah deploy semuanya kedaluwarsa (100 per tenant per tick), tiap satu mengirim `approval.resolved(expired)` dan notifikasi, dan cuti, lembur, PR/PO, refund, jurnal, aksi AI ikut selesai sebagai kedaluwarsa. Periksa dulu apakah itu diinginkan.

## 4. Event outbox yang mati (override POS lewat HP tidak pernah selesai)

```sql
SELECT tenant_id, destination, count(*) AS jumlah,
       min(dead_lettered_at) AS pertama, max(dead_lettered_at) AS terakhir
FROM domain_event_outbox
WHERE dispatch_state = 'dead'
  AND event->>'name' = 'approval.resolved'
GROUP BY tenant_id, destination ORDER BY jumlah DESC;
```

Baris yang jatuh di jendela m1 bisa diputar ulang lewat rute operator replay outbox (hanya baris `dead`). Pisahkan yang mati karena sebab lain dulu (lihat log worker pada waktu itu: `AuditUnavailableError`).

Putar ulang (legend-cx3nb), hanya SETELAH worker dengan audit writer terdeploy (gerbang rilis founder):

1. Daftar id baris dalam jendela, hanya yang pos_override (modul lain, misalnya cuti, refund, jurnal, punya konsumen sendiri: putuskan terpisah):

   ```sql
   SELECT id, tenant_id, destination, dead_lettered_at
   FROM domain_event_outbox
   WHERE dispatch_state = 'dead'
     AND event->>'name' = 'approval.resolved'
     AND event->'payload'->>'sourceModule' = 'pos_override'
   ORDER BY dead_lettered_at;
   ```

2. Per id: `POST /api/ops/outbox/:outboxId/replay` dengan body `{ "reason": "legend-cx3nb: dead di jendela m1 tanpa audit writer" }`. Perlu izin `ops.outbox.replay` dan sesi operator di tenant baris itu (jalankan per tenant). `:outboxId` harus ULID 26 karakter, bukan uuid dari kolom `id`: ubah dulu dengan `uuidToUlid` dari `@starter/shared/core`. Rute ini per id (tidak ada replay massal); mulai dengan satu baris dan cek hasilnya sebelum sisanya.
3. Cek: baris keluar dari `dead`, `pos_overrides.status` bukan `pending`, ada jejak di `domain_event_replays`.

Aman dari sisi uang (review architect, test `legend-cx3nb AUTH-06 (a)-(e)` di `staff-override-consumers.test.ts` dan `pos-order-approval.test.ts`): konsumen idempoten dan gagal-tertutup. Chain yang lewat batas waktu menjadi `expired` tanpa override. Chain yang disetujui tepat waktu hanya dicatat dan tidak memindahkan uang; uang bergerak lewat `consumeApproval`, yang menuntut persetujuan segar (jendela 15 menit dari waktu keputusan, bukan waktu replay). Terbukti dengan test untuk void; refund dan diskon memakai jalur yang sama menurut review architect, tetapi belum ada test sendiri. Izin approver dicek ulang saat replay; dicabut berarti `rejected`.

## 5. Event edge yang diparkir lalu ditandai `refused` selamanya

```sql
SELECT tenant_id, event_name, count(*) AS jumlah,
       min(applied_at) AS pertama, max(applied_at) AS terakhir
FROM edge_deferred_events
WHERE apply_outcome = 'refused'
GROUP BY tenant_id, event_name ORDER BY jumlah DESC;
```

Perilaku kode (legend-ngyd7, `edge/access-applier.ts`): `drainParkedAccessEvents` menandai baris `refused` bila event ditolak, lalu membuang bahan PIN dari envelope. Pengecualian: bila penolakannya hanya `AuditUnavailableError` (tidak ada audit writer), baris tetap `refused`, envelope dibiarkan utuh, dan envelope diberi penanda `refusal = "audit_unavailable"` (jsonb, tanpa migrasi) supaya bisa diputar ulang. Replay hanya memproses baris bertanda itu. Baris yang sudah ditandai sebelum perbaikan ini tidak punya bahan lagi untuk `staff_pin.set`: tidak bisa dipulihkan dari sini (edge mengirim ulang set barunya). `pos_override.recorded` tidak membawa bahan rahasia, jadi tetap bisa diputar ulang.

Cocokkan dengan log worker "Parked edge access events refused during drain" yang memuat `AuditUnavailableError` untuk menentukan jendela. Pemulihan hanya SETELAH worker dengan audit writer terdeploy:

1. Daftar event id kandidat per outlet (hanya baris di jendela; periksa dulu envelope `staff_pin.set` masih punya `payload.material`):

   ```sql
   SELECT tenant_id, outlet_id, event_id, event_name, applied_at,
          envelope->>'refusal' AS penanda
   FROM edge_deferred_events
   WHERE apply_outcome = 'refused'
   ORDER BY tenant_id, outlet_id, applied_at;
   ```

2. Per outlet, panggil `replayRefusedAccessEvents(tx, meta, outletId, { eventIds })`. Fungsi ini idempoten: hanya memilih baris `refused` outlet itu (FOR UPDATE) yang bertanda `penanda = 'audit_unavailable'`. Baris `refused` tanpa penanda (penolakan sungguhan, atau baris warisan jendela m1) dilewati tanpa diubah dan dihitung di `skippedUnmarked`. Selain itu: melewati `staff_pin.set` tanpa bahan (tidak disentuh), menerapkan tiap baris di savepoint sendiri, lalu menandai `applied` / `not_applicable` (penanda ikut dibuang). Baris outlet lain dan baris yang sudah diterapkan tidak tersentuh, jadi aman diulang. Penolakan sungguhan menandai bahan terbuang; `AuditUnavailableError` berulang membiarkan baris persis seperti semula (penanda tetap).
   - Baris warisan jendela m1 (ditandai `refused` sebelum penanda ada, `penanda` kosong) yang menurut operator memang ditolak hanya karena audit writer: cocokkan dengan log worker dan jendela waktunya, sebutkan id-nya satu per satu di `eventIds`, lalu tambahkan opsi `acknowledgeUnmarked: true`: `replayRefusedAccessEvents(tx, meta, outletId, { eventIds, acknowledgeUnmarked: true })`. Tanpa opsi itu baris tanpa penanda dilewati, jadi penolakan sungguhan tidak ikut terputar ulang. Jangan memakai opsi ini untuk daftar yang belum diperiksa.
   - Langkah meta: `meta` (`EdgeApplyMeta` tanpa `edgeNodeId`) berisi `direction: "edge_to_cloud"`, `kind: "transaction_event"`, dan `context` tenant outlet itu; `tx` didapat dari `withTenant(db, context, (tx) => ...)` dengan context tenant yang sama. Node tiap baris diambil dari baris itu sendiri. Pastikan audit writer terpasang di proses yang menjalankan panggilan ini; tanpa itu semua baris tetap seperti semula.
3. Cek: ulangi query bagian 5; baris yang pulih keluar dari daftar `refused`.
