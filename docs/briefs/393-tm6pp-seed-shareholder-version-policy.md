# Brief: engineer — seed kebijakan approval shareholder_version (tm6pp)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baru `.worktrees/tm6pp-seed-policy`, cabang `ws/tm6pp-seed-policy`, dari `ws/3sy9b-share-alloc-approval` (berisi 54b76963 + 360491fa). Lalu `pnpm worktree:setup`.

## Tujuan
Keputusan founder (Q2, 10 Nov): saat tenant mulai memakai profit share, kebijakan approval untuk action `shareholder_version` (dan action alokasi saham dari 3sy9b, bila terpisah) otomatis ada: disetujui Owner, 1 tingkat. Pemilik tetap bisa mengubahnya. Isi saat provisioning tenant, dan migrasi backfill untuk tenant lama yang BELUM punya kebijakan untuk action itu (jangan timpa yang sudah ada). Pakai pola seed kebijakan approval yang sudah ada bila ada (cari dulu dengan Explore).

## Kartu
`legend-tm6pp`. Di awal: `ghostex board associate legend-tm6pp` dan `bd update legend-tm6pp --status in_progress`. Saat melapor: `bd update legend-tm6pp --status review` dan `bd comment legend-tm6pp "<ringkasan bahasa biasa>"`.

## Scope
- Boleh diubah: provisioning tenant, modul approval policy, profit-share approval, test terkait, satu migrasi.
- Jangan disentuh: logika distribusi/clawback profit share, modul pembayaran.
- Migrasi: nomor 0259 saja, `when` 1794405000000 (di atas 0255 r77pq 1794400000000 dan 0256-0258 HRIS). Jangan menomori ulang migrasi lain.

## Bukti selesai
- Test gagal-dulu: tenant baru punya kebijakan Owner 1 tingkat; tenant lama tanpa kebijakan dapat backfill; tenant yang sudah punya kebijakan tidak berubah; migrasi idempoten.
- `LEGEND_TEST_FILES="..." pnpm test`; lint + typecheck paket berubah lewat `heavy`; `pnpm exec prettier --check <berkas berubah>`; `pnpm db:generate` kosong.
- Review tingkat K (akses + migrasi): satu subagent `architect`, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck` atau `tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
- Jam dari `date '+%H:%M'`.
- Di zsh jangan pakai `F=("${(@f)$(git diff --name-only)}")`; pakai `git diff --name-only | while read f`.

## Sebelum melapor
Commit di `ws/tm6pp-seed-policy`, push ke `origin`.

## Laporan
Hasil, bukti (perintah dan hasil), file berubah, commit, nomor migrasi + `when`, jumlah subagent dan puncak bersamaan, risiko tersisa.
