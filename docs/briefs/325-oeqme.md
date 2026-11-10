# legend-oeqme: antrean lokal edge untuk penerapan kuota Wi-Fi

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (migrasi): satu subagent architect review.
Basis: `git worktree add .worktrees/oeqme -b ws/oeqme-wifi-queue ws/wifi-edge` (8b57852f). Jangan checkout folder utama. Jangan push.

## Masalah
Di ws/wifi-edge (legend-xk7az), event kuota Wi-Fi dari cloud diterapkan ke controller di dalam transaksi terima tautan cloud->edge. Agen Wi-Fi belum siap memberi 503, transaksi rollback, dan seluruh tautan outlet tertahan (pesanan ikut tertahan). Keputusan CTO: wajib sebelum rilis.

## Kerja
1. Test gagal-dulu: agen Wi-Fi 503 tidak boleh menahan event lain di tautan; event pesanan sesudahnya tetap diterima.
2. Terima event Wi-Fi ke tabel antrean lokal edge (ikuti pola `edge_received_events`, lihat `apps/api/src/test/edge-received-events-migration.test.ts`) di transaksi terima. Terapkan ke controller async di luar transaksi: retry dengan backoff, idempoten per event id, urutan per perangkat/pelanggan dijaga, status gagal permanen terlihat (audit/alert yang sudah ada).
3. Migrasi baru: nomor sementara 0220, `when` 1794299000000 (merge train akan menomori ulang). `db:generate` kosong sesudahnya.
4. Typecheck dan test terkait lewat `heavy`. Architect review delta, temuan nyata dibetulkan dengan test.
5. Commit lokal, `bd comment legend-oeqme` ringkas, update `docs/PROGRESS.md`.

Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain.

## Laporan
Sekali di akhir: SHA, migrasi, test gagal-dulu, temuan architect, perilaku retry.
