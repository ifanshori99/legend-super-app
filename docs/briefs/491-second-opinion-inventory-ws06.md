# 491 Second opinion Codex: inventori resep WS-06 (area)

Peran: second-opinion (`~/.agents/team/roles/second-opinion.md`). Read-only. Jangan edit, jangan commit. Effort high (stok dan HPP, migrasi 0293).

Repo: `/Users/ifanshori99/Projects/legend super app/legend`. Baca AGENTS.md.

Cakupan: `git diff origin/milestone/m1...origin/ws/inventory-recipes-bundle` (1e035dd4 routing lokasi per baris + cek UOM, 149b718b repost idempoten legend-q55i, 8dc9b06a fallback lokasi jual outlet legend-89zm).
Fokus: potong stok ganda atau terlewat (repost, swap-return, reversal), lokasi salah antar outlet/tenant, HPP snapshot vs potongan stok, idempotensi repost di bawah konkurensi, migrasi 0293 aman untuk data ada, isolasi tenant (RLS).

Sudah diketahui (jangan dilaporkan ulang): repost manual akan memotong stok hari lalu di lokasi jual sekarang (disengaja); dua bug P3 dari architect (swap-return terlewat saat lokasi jual berubah + dua baris jual; HPP snapshot menganggap lokasi sendiri nonaktif bisa dipakai); `reason` dipotong 200 karakter.

Laporan: temuan P0..P3, file:line, skenario gagal konkret, usul perbaikan. Maks 12, urut keparahan. Tidak ada temuan: tulis "bersih" plus apa saja yang dicek.
