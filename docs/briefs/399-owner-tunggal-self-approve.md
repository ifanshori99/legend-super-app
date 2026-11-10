# Brief: engineer — Owner tunggal boleh menyetujui sendiri (kartu legend-b8y6l)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/owner-self-approve`, cabang `ws/owner-self-approve`, dari `milestone/m1` SETELAH batch48b masuk (cek `git log milestone/m1 --oneline | grep -i tm6pp`; belum ada: lapor, jangan mulai). Lalu `pnpm worktree:setup`.

## Tujuan
Keputusan founder: tenant dengan tepat satu Owner aktif boleh menyetujui pengajuan perubahan data pemegang saham (shareholder_version / approval share allocation dari 3sy9b, policy seed tm6pp) yang ia ajukan sendiri. Tenant 2+ Owner tetap butuh penyetuju lain.
- Hitung Owner aktif di SQL dalam transaksi approve, dengan kunci baris yang cegah race (Owner kedua ditambah di tengah). Jangan percaya input.
- Audit wajib menandai self-approval dan alasannya (owner tunggal).
- Kontrak dan pesan error tetap; tambahkan field bila UI perlu tahu (mis. `selfApprovalAllowed`).

## Kartu
`legend-b8y6l`. Awal: `ghostex board associate legend-b8y6l`, `bd update legend-b8y6l --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
Hanya modul approval profit share/shareholder di `apps/api`, validator `packages/shared` bila perlu, test. Tanpa migrasi kecuali terpaksa (rentang 0270, when > 1794440000000).

## Bukti selesai
- Test gagal-dulu: owner tunggal setujui sendiri lolos + audit; 2 owner self-approve ditolak; owner kedua ditambah lalu self-approve ditolak; isolasi tenant.
- Test terarah, typecheck via `heavy`, prettier, `pnpm db:generate` kosong.
- Review tingkat K (uang + akses): satu `architect` opus effort xhigh.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis, betulkan semua. Gagal ketiga: lapor. Tunggu job lewat notifikasi, bukan sleep. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit, push `ws/owner-self-approve`. Hasil, bukti, file, commit, subagent dan puncak, risiko.
