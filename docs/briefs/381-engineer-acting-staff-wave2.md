# Brief: engineer — kasir aktif gelombang 2: floor, table-sessions, table-links, KDS (legend-ptn11)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Tingkat K (akses): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/ptn11-acting-w2 -b ws/ptn11-acting-staff-w2 ws/aruta-pos-pin`. Push cabang kerja tiap commit. Jangan push main, jangan --force.

## Tujuan
Gelombang 1 (aruta f609a047) membuat rute POS inti mencatat pelaku dan memakai izin kasir aktif dari header `X-Acting-Staff` (tabel `pos_acting_staff`, migrasi 0243, middleware `apps/api/src/middleware/acting-staff.ts`). Rute berikut masih mencatat atas nama pemilik sesi: floor, table-sessions, table-links, KDS. Pasang middleware yang sama di rute mutasi itu: pelaku audit dan cek izin = kasir aktif bila header ada dan valid; header tidak valid atau kedaluwarsa = 401/403, bukan jatuh ke pemilik sesi.
Mulai dengan test gagal-dulu per rute (mutasi tercatat atas nama pemilik sesi padahal ada kasir aktif).

## Kartu
`legend-ptn11`. `ghostex board associate legend-ptn11`, `bd update legend-ptn11 --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh: rute dan service floor, table-sessions, table-links, KDS; test-nya; klien web yang memanggil rute ini supaya mengirim header.
- Jangan disentuh (thread lain sedang mengubah): `apps/web/src/lib/api/acting-staff.ts`, `apps/api/src/services/pos-acting-staff.service.ts`, `apps/api/src/edge/access-applier.ts`, `apps/api/src/routes/device-pin.routes.ts` (legend-5u03q); `bill-split.service.ts` (udu47/ec6fa).
- Migrasi: tidak diharapkan; bila wajib 0253 saja.

## Bukti selesai
- Test gagal-dulu tiap rute, hijau sesudah fix.
- Typecheck dan test terarah lewat `heavy`. Architect review.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Laporan
SHA, rute yang diubah, test gagal-dulu, temuan review, risiko.
