# Brief: engineer — tindak lanjut config tenant (z1qk8, it6p4, ms2a)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Tiga kartu, berkas berbeda: 3 Explore paralel, lalu implementer paralel per kartu.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baru `.worktrees/tenant-config-followups`, cabang `ws/tenant-config-followups`, dari `ws/tenant-config-export` (30764f2c), lalu `git merge --no-ff ws/fe-badge-theme` (f2815e9a, butuh prop `overrides` di Providers). Lalu `pnpm worktree:setup`.

## Tujuan
1. legend-z1qk8: impor template ke tenant yang pengaturan pajak/service charge-nya masih persis default provisioning -> template menimpa. Sudah diubah pemilik -> lewati dan laporkan di hasil impor.
2. legend-it6p4: GET publik (tanpa auth) text override tenant dari host, hanya teks yang aman untuk publik (tentukan allowlist kunci), cache wajar; isi prop `overrides` di Providers root lewat server fn seperti `getTenantBrandFn`. Rate limit dan tanpa data pribadi.
3. legend-ms2a: scan teks bebas (label checklist, text override) untuk data pribadi (telepon, email, NIK, nama orang bila mungkin) sebelum template dibagikan; tolak atau minta konfirmasi dengan daftar temuan.

## Kartu
`legend-z1qk8`, `legend-it6p4`, `legend-ms2a`. Di awal: `ghostex board associate <id>`, `bd update <id> --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
- Boleh: modul tenant config/template, route publik tenant, `apps/web` root/Providers/tenant-brand, `packages/shared` validator, test terkait.
- Jangan: uang, migrasi lain. Migrasi bila perlu: 0268-0269, `when` di atas 1794423000000.

## Bukti selesai
- Test gagal-dulu per kartu (termasuk endpoint publik tidak membocorkan kunci di luar allowlist, tenant lain, host tak dikenal).
- Test terarah; typecheck paket berubah lewat `heavy` (satu per worktree pada satu waktu); prettier; `pnpm db:generate` kosong.
- Review: it6p4 endpoint publik tanpa auth = tingkat K: satu `architect` opus effort high. Lainnya satu `reviewer` sonnet.

## Batas kerja ulang
- `typecheck` gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua. Gagal ketiga: lapor.
- Tunggu job lewat notifikasi, bukan loop sleep. Jangan `pkill`. Jam dari `date '+%H:%M'`. Di zsh pakai `git diff --name-only | while read f`.

## Sebelum melapor
Commit per kartu, push `ws/tenant-config-followups` ke `origin`.

## Laporan
Hasil, bukti, file berubah, commit, jumlah subagent dan puncak bersamaan, risiko tersisa.
