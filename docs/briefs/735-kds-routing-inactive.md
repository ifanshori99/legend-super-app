# Brief: engineer (Codex) — routing tiket dapur lewati stasiun nonaktif (legend-0b0t5)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show legend-0b0t5` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/kds-routing-inactive .worktrees/kds-routing-inactive origin/ws/kds-station-save` (cabang d0dc5a183 yang menambah `stations.is_active` dan `display_order`; belum masuk milestone).

## Tujuan (keputusan CTO, jangan buka ulang)
Routing item tiket dapur melewati stasiun `is_active = false`. Item yang target stasiunnya nonaktif dialihkan ke stasiun aktif dengan `display_order` terkecil di outlet yang sama. Item tidak boleh hilang. Simpan stasiun sudah menolak 0 stasiun aktif; bila tetap tidak ada stasiun aktif (data lama), perilaku lama dipertahankan. Cari semua jalur routing (API dan edge bila ada di repo; edge sync tabel stations adalah legend-i78o6, jangan dikerjakan). Tanpa migrasi.

## Bukti, sebelum melapor
Test gagal-dulu (item ke stasiun nonaktif jatuh ke stasiun aktif pertama; tenant/outlet lain tidak tersentuh) lalu hijau (`LEGEND_TEST_FILES=... heavy pnpm test`), pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge, jangan deploy.
