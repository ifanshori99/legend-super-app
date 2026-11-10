# 210b result (architect 2, claude-double) — legend-jcby0

Reviewed: `git diff 76d09e88..5eed1767` (ws/receipt-writeoff-edge-sync, not in milestone/m1 yet). Read-only.

| id brief | kartu | hasil | kartu baru | catatan |
|---|---|---|---|---|
| 210b | legend-jcby0 | Bersih (tidak ada P1/P2) | - | 5 catatan P3 di bawah |

## Jawaban pertanyaan brief

1. **Nomor dihitung ada padahal masih bisa terbit / dalam perjalanan.** Tidak ditemukan. Syarat salin di edge (`apps/api/src/services/edge-device-sync.ts:310-339`: run sama id+outlet+prefix, `last_number >= n`, tidak ada struk lokal) sama dengan trigger 0156 (`pos-receipt-writeoff.custom.sql`), dan trigger tetap jadi backstop di edge (23514 dilewati, :360-366). Alokasi di edge gapless dalam transaksi jual, dan `mergeDeviceReceiptRun` hanya menaikkan `last_number` atas run lengkap, jadi `last_number >= n` tanpa struk = lubang nyata di DB ini. Struk terlambat sesudah salin: `writeoffOrdinalsBySequence` (NOT EXISTS) membatalkan write-off, sama dengan cloud. Restore (last_number turun): baris dilewati sampai run lewat n, dan nomor n yang diterbitkan ulang punya struk lokal, jadi dilewati. Clone, rotasi zsdd, heal hfq3z, pensiun sduiq: run lama tetap ada (retired) dan dicek per DB, run baru mulai 0, jadi tidak ada salinan yang salah. Race dengan merge struk terlambat: hasil akhirnya write-off + struk, write-off jadi moot.
2. **Isolasi.** Cloud: tenant/outlet dari kredensial node (`verified`), filter eksplisit + RLS outlet (:400-409). Edge: konteks satu outlet, baris outlet lain menolak seluruh daftar (:259-261), run dicari di tenant+outlet sendiri, insert memakai `ownOutletId`. Id dari payload hanya PK; bentrok dengan baris yang tak terlihat RLS jatuh ke `onConflictDoNothing` (dilewati, tidak menulis lintas tenant).
3. **Idempoten, >1000, baris rusak, galat baca.** Idempoten (set `present` + `onConflictDoNothing`). Baris rusak: seluruh daftar ditolak, pull tetap jalan (fail closed). Galat baca cloud: savepoint, field tidak dikirim. Batas reason zod (UTF-16 `.max(500)`) sama dengan skema input write-off, jadi tidak ada poison pill dari emoji.
4. **Kompat.** Edge lama + cloud baru: tidak minta, tidak dapat. Edge baru + cloud lama: 400, ulang tanpa parameter; parse query terjadi sebelum efek samping (klaim/rotasi), jadi pengulangan aman. Rollback kode cloud: sama dengan cloud lama.
5. **Halaman ganda dan rantai 400.** Diterapkan sekali per pull, sesudah sequences halaman pertama yang membawanya; daftar sequences lengkap di tiap halaman, jadi run baru sudah ada. Rantai: percobaan ke-2 identik dengan percobaan pertama versi hfq3z, lalu rantai lama tidak berubah (`apps/api/src/edge/cloud-http.ts:188-206`).

## Catatan P3 (tidak dibuat kartu)

- P3 `edge-device-sync.ts:137-168` + JSDoc `schemas.ts` `RECEIPT_WRITEOFF_SYNC_MAX`: asumsi "baris lama sudah ada di edge" salah untuk DB edge yang dibangun ulang atau edge yang pernah menolak daftar. Lewat 1000 write-off per outlet, baris lama tidak pernah sampai; Tutup Hari edge tertahan (fail closed). Praktis jarang. Saran: catat di runbook (tutup hari lewat cloud).
- P3 `edge-device-sync.ts:136-186`: daftar penuh (sampai sekitar 0,5 MB dengan reason 500 karakter) dikirim di setiap halaman setiap pull, padahal edge memakai satu kali. Saran nanti: kirim hanya di halaman pertama (tanpa `since`) atau pakai cursor.
- P3 runbook `receipt-number-writeoff.md`: salinan edge append-only tetap ada bila DB cloud dipulihkan ke titik sebelum write-off; edge lolos Tutup Hari sementara cloud menolak. Tambah satu kalimat di bagian rollback.
- P3 `edge-device-sync.ts:136`: cloud mengirim write-off (termasuk teks reason dan id user) ke node mana pun yang meminta, termasuk standby dan node tanpa binding, padahal hanya primary terikat yang memakai. Data outlet sendiri, risiko rendah; bisa dibatasi ke `binding !== null`.
- P3 `cloud-http.ts:188-206`: edge baru ke cloud lama membuat satu 400 tambahan per halaman sampai cloud diperbarui. Urutan rilis cloud dulu sudah menutupnya.
