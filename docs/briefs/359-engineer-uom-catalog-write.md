# Brief: engineer — katalog satuan (UOM) tenant: tambah dan ubah (legend-ie6m)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat S: satu subagent reviewer sonnet (naik ke architect bila menyentuh migrasi data lama).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/ie6m-uom-write -b ws/ie6m-uom-write milestone/m1`. Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Tenant bisa menambah dan mengubah satuan (UOM) di katalognya sendiri: kontrak dulu, lalu route + service, validasi konversi, tidak bisa mengubah satuan bawaan sistem, RLS per tenant, audit log.

## Kartu
`legend-ie6m`. Di awal: `ghostex board associate legend-ie6m` dan `bd update legend-ie6m --status in_progress`. Saat melapor: `bd update legend-ie6m --status review` dan `bd comment legend-ie6m "<ringkasan>"`.

## Masukan
- `bd show legend-ie6m`. Cek dulu kode UOM yang sudah ada di m1 (WS-06); jangan tulis ulang.
- Kontrak di `packages/shared`; tambahkan endpoint di kontrak dulu.

## Scope
- Boleh diubah: modul inventori/UOM di `apps/api`, kontrak terkait di `packages/shared`, schema + migrasi baru.
- Jangan disentuh: rute HRIS/edge (`apps/api/src/edge/`), auth, staff PIN, modul akuntansi, pembayaran.
- Migrasi: rentang 0245-0246 saja, FK inline di CREATE TABLE, migrator non-superuser.

## Bukti selesai
- Test gagal-dulu tiap butir (tambah, ubah, tolak satuan bawaan, isolasi tenant, audit).
- Typecheck dan test terarah lewat `heavy`.
- Review reviewer, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck` atau `tsc` gagal 2 kali di kartu yang sama: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Sebelum melapor
Commit, push cabang kerja, update `docs/PROGRESS.md`.

## Laporan
SHA, test gagal-dulu, temuan review, kartu sisa, risiko.
