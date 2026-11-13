# 659: n1fzg + btx4d (ketahanan sync edge)

Worktree `.worktrees/edge-resilience-659`, branch `ws/edge-sync-resilience`. Area uang/sync: jangan sampai rugi. Migrasi rentang **0538-0541** (file terakhir di cabang: 0522; pakai nomor dari rentang, cek `apps/api/drizzle/meta/_journal.json` dan registry/referensi test yang menyebut nomor migrasi).

## n1fzg: struk dari order ditolak permanen tidak boleh menahan run
- Konsumer cloud: `apps/api/src/edge/receipt-run-applier.ts` (`applyReceiptRunReported` ~l.60-102, `refuseMerge` l.48) memanggil `mergeDeviceReceiptRun` (`services/pos-receipt.service.ts`).
- Penolakan permanen: `edge/order-ingest.ts` (`legacy_payload` ~l.341, `order_exists` ~l.348), dicatat di `edge_order_ingests` (`state='refused'`, `reason`), schema `db/schema/edge-order-ingest.ts`.
- Produsen: `services/edge-receipt-run-reporter.ts` (limit dikenal l.47-50; `docs/design/edge-order-ingest.md` l.189-196).
- Perilaku target: di applier, sebelum merge, struk milik order dengan `edge_order_ingests.state='refused'` + reason permanen (`order_exists`, `legacy_payload`) DILEWATI (tidak ikut merge, nomor urut tidak jadi lubang yang menahan chunk berikutnya), struk lain tetap tergabung. Catat konflik yang terlihat finance sekali per (tenant, order) lewat `edgeSyncConflicts` (`db/schema/edge-node.ts:383`, `edge/conflict.ts` reason union, `recordConflict`); idempoten pada redelivery. Tidak hapus-buku diam-diam: struk yang dilewati tercatat (nomor, order, alasan). Tidak membuat pendapatan.
- Test gagal-dulu: struk berikutnya tetap tergabung, konflik tercatat tepat sekali (ulang event = tidak ganda), tidak ada uang dibuat.

## btx4d: event di atas batas frame -> dead-letter + alarm, antrean lanjut
- `edge/link-peer.ts` `pump()` l.219-248; l.242 event tunggal > `LINK_BATCH_MAX_BYTES` (`protocol.ts:27`) hanya `onError` lalu berhenti, antrean di belakang tertahan. Store: `LinkStore` (`link-peer.ts:54-61`), implementasi `edge/db-link-store.ts` (`readOutbound` l.342, `ackOutbound` l.355). `runtime.ts:899` hanya log. Preseden alarm: `edge/catalog-alarm-queue.ts`, `onOwnerAlarm` (`runtime.ts:1170`).
- Perilaku target: event itu dipindah ke dead-letter (tabel baru, migrasi, event tetap tersimpan utuh: payload/ukuran/seq/alasan, dicatat sekali), alarm ops keluar sekali, kursor maju, antrean berikutnya terkirim.
- Test yang harus dibalik: `test/edge-link-batch-bytes.test.ts:135` (sekarang menegaskan antrean menunggu). Juga cek `edge-db.test.ts`, `edge-link-hardening*.test.ts`.
- Test gagal-dulu: antrean di belakang event besar terkirim, dead-letter tercatat sekali (replay/restart tidak ganda), alarm keluar, event asli masih bisa dibaca.

## Aturan
- Tipe brand (`TenantId`, dll): pakai konstruktor/helper proyek. Katalog/registry silang: tabel baru wajib masuk tes cakupan tabel, alarm/event baru terdaftar di katalog dan label teks.
- Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree. Satu proses berat sekaligus per thread.
