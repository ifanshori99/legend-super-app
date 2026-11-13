# Brief: engineer — perbaikan temuan Codex alarm darurat edge

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (sinkron edge + keselamatan).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/edge-emergency-impl` (a68680f4). Push ke `origin` sebagai `fix/codex-edge-emergency`.

## Kartu `legend-w5u1a` (keputusan sudah diambil CTO; jangan ditanyakan)
1. P1 `apps/api/src/routes/emergency-cloud.routes.ts:72`: ACK di cloud tanpa `refuseWhenEdgeServesOutlet`. Tambahkan penolakan yang sama seperti mutasi edge lain.
2. P1 `panic-alert-outbox.ts:195`: resolve dikirim ke node aktif tertua. Benar: targetkan node pemilik alert, plus salinan node aktif saat failover.
3. P1 `panic-relay.service.ts:465`: cek sesi gagal saat kirim pertama membuat alert tidak masuk retry. Pulihkan dari alert terbuka di DB (bukan hanya RAM), termasuk setelah restart.
4. P2 `panic-relay.service.ts:703`: event delivery menunggu timer RAM. Simpan transaksional, pulih setelah restart.
5. Q94 founder: fallback alarm ke semua layar POS outlet tetap muncul bila 15 detik tanpa ACK manusia. Receipt otomatis ponsel TIDAK menghentikan fallback.

Founder: owner = manajer (terima alarm saat on duty, boleh tutup insiden di cloud); tutup insiden hanya OM/GM/owner di cloud.

`bd update legend-w5u1a --status in_progress` di awal; lapor `--status review` + `bd comment`.

## Pembagian paralel
test-writer (5 test gagal-dulu, satu per butir), implementer 3 file terpisah (routes; outbox; relay service), satu reviewer `architect` effort high atas diff akhir, satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test` (test baru + test emergency/panic terkait); typecheck api via `heavy`; prettier + eslint; migrasi baru (bila terpaksa) `db:generate` kosong.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
