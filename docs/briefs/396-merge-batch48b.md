# Brief 396: merge train batch48b ke milestone/m1

Peran: merge train (engineer.md). Tidak mereview ulang isi cabang (semua sudah direview, tingkat K oleh architect). Basis: `milestone/m1` 0f2802e7.

## Cabang (urut, `--no-ff`; cek tip = SHA ini, beda -> lapor dulu)
1. ws/u7g9w-pin-proof 2c7957bf
2. ws/jmsdx-pepper be9ce98d (berisi u7g9w, sp9vq, vfj7z)
3. ws/ptn11-acting-staff-w2 11bf4249
4. ws/kxoyf-pos-swap 397928f1
5. ws/split-claim-hide 81efe255
6. ws/claim-payer-secret 569dcd1d (berisi ws/ec6fa-claim-race 425288af). Web+API wajib rilis bersama.
7. ws/w5by9-expiry-fifo d735d8b7
8. ws/tm6pp-seed-policy 868e8a71 (berisi ws/3sy9b-share-alloc-approval 360491fa dan 8s992 54b76963; 0217 diedit di tempat oleh 33im6: DB dev/test reset)
9. ws/cpq2-qr-read-models d3dc89d2

## Migrasi
Nomor sementara di cabang bertabrakan: 0252+0256 (3sy9b), 0255 (claim-payer-secret), 0258 (jmsdx), 0259 (tm6pp), plus apa pun di u7g9w/ptn11/kxoyf/w5by9/cpq2. Nomori ulang berurutan mulai 0235, `when` naik 1000000 dari 1794316000000, snapshot dibangun ulang dari skema gabungan, `db:generate` kosong setelah tiap merge. FK baru inline di CREATE TABLE; FORCE RLS dilepas-pulihkan bila perlu (pola 0230). Tulis tabel penomoran di laporan dan `docs/release-notes-m1-migrations.md`.
Tulis langkah renumber + rebuild snapshot sebagai script `scripts/migration-renumber.mjs` (dipakai lagi batch48c) sebelum merge kedua.

## Paralel (Retro 12)
- Sebelum merge: 3 Explore paralel memetakan konflik dan migrasi per kelompok cabang (1-3, 4-6, 7-9).
- Test gagal setelah merge: bagi per berkas ke `implementer` paralel (maks 4), bukan satu per satu.
- Jangan menunggu dengan loop sleep; `heavy` di latar, tunggu notifikasi.

## Gate
Typecheck 3 paket, `heavy pnpm test` penuh sekali di akhir (rerun file gagal sendiri; flake dikenal di legend-0lyzf), `heavy pnpm test:e2e`, lint. Architect atas diff migrasi saja.

## Sesudah
Push m1 dan cabang merge (tanpa force). Hapus worktree cabang yang masuk dan bersih. Tutup bead yang selesai. Lapor: m1 baru, tabel migrasi, perbaikan di luar konflik, gate, subagent (jumlah dan puncak). Batch48c (FE/config: fe-small-tests, u37u3, fe-badge-theme, tenant-config-export, print-agent) menunggu perintah CTO.
