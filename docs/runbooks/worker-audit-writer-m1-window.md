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

## 5. Event edge yang diparkir lalu ditandai `refused` selamanya
```sql
SELECT tenant_id, event_name, count(*) AS jumlah,
       min(applied_at) AS pertama, max(applied_at) AS terakhir
FROM edge_deferred_events
WHERE apply_outcome = 'refused'
GROUP BY tenant_id, event_name ORDER BY jumlah DESC;
```
`drainParkedAccessEvents` menangkap semua error per baris, menandai `refused` dan menghapus isi envelope (`edge/access-applier.ts`), jadi perbaikan kode tidak memulihkan baris ini. Cocokkan dengan log worker "Parked edge access events refused during drain" yang memuat `AuditUnavailableError` untuk menentukan jendela. Pemulihan (menyetel ulang `applied_at`) hanya setelah envelope dipastikan masih utuh; kartu terpisah.
