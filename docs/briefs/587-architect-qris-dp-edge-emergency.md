# Brief: architect (Claude Opus, effort xhigh) — dua desain: QRIS ber-DP dan tombol darurat edge

## Peran
Baca `~/.agents/team/roles/architect.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`. Kerjakan berurutan, selesaikan keduanya, lalu lapor. Hanya dokumen desain + kartu; tidak menulis kode produk.

## Repo
Worktree basis `milestone/m1`. Cabang `design/qris-dp-edge-emergency`. Pakai subagent Explore untuk membaca kode (jangan baca banyak file sendiri).

## Desain 1 — legend-yhia9 (uang, prasyarat buka HOLD QRIS ber-DP legend-y5d2r)
`bd show legend-yhia9 legend-y5d2r`. Test uang sudah ada di `origin/ws/qris-dp-due` (54682a08). Architect uang sebelumnya menahan HOLD karena QR lama yang terbayar hanya memicu refund pending (pelanggan bisa bayar lebih). Arah CTO (paling membatasi): selama ada intent QRIS pending, DP tidak bisa dipasang/diubah; kasir batalkan QR dulu, QR baru terbit hanya setelah intent lama terbukti batal/kedaluwarsa di penyedia. Desain: backend layar pelanggan (pairing, tagihan aktif), satu intent QRIS aktif per tagihan, aturan DP vs QR aktif, webhook terlambat, idempotensi. Wajib: tabel kasus yang membuktikan tidak ada pihak dibayar lebih dan outlet tidak rugi (aturan founder "Jangan sampai rugi"). Keputusan bisnis yang tidak bisa diambil teknis: tulis sebagai pertanyaan untuk CTO dengan rekomendasi.
Tulis `docs/design/qris-dp-intent.md` + kartu bd anak (engineer, test-writer) dengan rentang migrasi **0419-0421**.

## Desain 2 — legend-bod (akses, tombol darurat edge)
Brief engineer lama: `docs/briefs/565-edge-emergency.md`. Draf relay WIP tersimpan (lihat W13 di `docs/PROGRESS.md`, cari "edge emergency"/"legend-bod"). Yang perlu diputuskan: PIN lokal sebagai autentikasi di edge (penyimpanan hash, rate limit, rotasi), pemulihan saat offline lalu online (sinkron insiden ke cloud tanpa duplikat), fan-out <=5 detik ke staf on-duty saja, isolasi tenant/outlet. Tulis `docs/design/edge-emergency.md` + kartu bd anak, migrasi tetap **0400-0402**.

## Bukti selesai
- Dua dokumen desain di-commit dan di-push ke `design/qris-dp-edge-emergency` tanpa --force. Kartu bd dibuat dan saling bergantung dengan benar.
- Lapor: ringkasan keputusan per desain, pertanyaan untuk founder (bila ada, dengan rekomendasi), kartu yang siap untuk engineer, angka subagent.
