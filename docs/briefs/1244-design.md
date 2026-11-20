# 1244 Desain: refund edge lama melewati yang dibayar (architect xhigh, read-only)

Bead legend-ecr16. Temuan engineer 1244 (worktree kosong `legend-1244`, cabang `ws/1244-edge-refund-ceiling` dari m1 6f418df53):
- Event edge `order.refunded` hanya diparkir di `edge_deferred_events`, tanpa hook ingest.
- Cloud sudah memblokir refund cloud bila ada refund edge belum terekonsiliasi (`pos-order-corrections.ts:1428`, `REFUND_HISTORY_UNVERIFIED`).
- Celah: refund cloud lebih dulu, lalu refund edge lama (offline) tiba; total refund > dibayar, uang tunai sudah keluar.

Tugas: pilih desain paling sederhana yang benar untuk rilis 1, prinsip jangan sampai rugi. Pertimbangkan pencegahan (mis. cloud menolak refund untuk order edge selama outlet belum sinkron / watermark edge, atau refund order edge hanya di edge) DAN deteksi (hook ingest `order.refunded` yang tidak pernah throw, catat hold/exception untuk finance: tabel baru vs dihitung saat baca; izin siapa yang menutup; batas kumulatif approver). Kode di `/Users/ifanshori99/Projects/legend super app/legend-m1-read`.

Keluaran: tulis `docs/briefs/1244-r2.md` di checkout utama `/Users/ifanshori99/Projects/legend super app/legend` berisi keputusan + langkah implementasi untuk engineer (file, migrasi bila perlu, izin, test fail-first) dan commit berkas itu saja (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Lapor ringkas keputusannya.
