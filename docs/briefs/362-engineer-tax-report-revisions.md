# Brief: engineer — laporan pajak: rantai revisi + service/routes (legend-r3i8w, legend-5nhkp)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (pajak = uang, migrasi): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/r3i8w-tax-reports -b ws/r3i8w-tax-reports origin/ws/gmww-accounting-deltas` (dd4db5d2). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Ikuti keputusan 3 di `docs/DECISIONS.md` cabang `origin/ws/arch-357-decisions` (da63d494): pembetulan = rantai revisi, banyak laporan final per periode, tepat satu berlaku; CHECK, dua index unik, trigger kunci kolom, cek rantai saat commit; ekspor hanya laporan berlaku, berkas lama tetap bisa diunduh. Lalu `legend-5nhkp`: generate draft, finalize (periode tertutup, `transitionTaxReport`), pembetulan, export Coretax XML (file_key via storage adapter), cek sum(lines.tax)=amount_idr di service.

## Kartu
`legend-r3i8w` lalu `legend-5nhkp`. Tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh diubah: modul akuntansi/pajak di `apps/api`, `packages/shared/src/accounting/tax.ts` + `endpoints.ts`, schema + migrasi baru.
- Jangan disentuh: migrasi 0235 (cabang gmww sudah dikirim ke merge train), POS, QR order, HRIS, edge.
- Migrasi: 0242 saja (kolom/constraint revisi di atas tabel `tax_reports`). FK inline, migrator non-superuser. `when` harus unik dan lebih tinggi dari semua migrasi lain di semua worktree (cek `_journal.json` di `.worktrees/*`).

## Bukti selesai
- Test gagal-dulu: dua final berlaku per periode ditolak DB, pembetulan ke-1/ke-2 (kode Coretax 1, 2), ekspor laporan lama ditolak tapi unduh berkas lama boleh, finalize di periode terbuka ditolak, sum pajak ≠ amount ditolak.
- Typecheck dan test terarah lewat `heavy`. Architect review, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Sebelum melapor
Selesaikan kedua kartu, lapor sekali. Commit, push, update `docs/PROGRESS.md`.

## Laporan
SHA, test gagal-dulu, temuan review, risiko, nilai `when` migrasi.
