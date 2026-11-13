# Brief: ui-engineer (tugas kecil) — input kode bank di dialog edit PII karyawan (legend-jazlx)

Peran: baca `~/.agents/team/roles/ui-engineer.md` dan `~/.agents/team/ui-standard.md`. Model Sonnet (tugas kecil).

## Konteks
API sudah ada di `fix/employee-bank-code` (ee6e5e38a, legend-86he4): `bankCode` di create/update PII karyawan, daftar 29 kode di `packages/shared/src/hris/bank-codes.ts`, null mengosongkan kode, ganti rekening tanpa kode ikut mengosongkan kode. Kanal gaji manual hanya menerima `014` (BCA).

## Repo
Worktree dari `origin/fix/employee-bank-code`: `git worktree add .worktrees/bankcode-ui-652 -b fix/employee-bank-code-ui origin/fix/employee-bank-code`, lalu `pnpm worktree:setup`.

## Kerja
- Tambah select kode bank (nama bank + kode, bisa dicari) di dialog edit PII yang ada, dekat field rekening. Pakai komponen shadcn yang sudah ada; ikuti pola field rekening (tersembunyi/ter-mask bila penonton tidak boleh melihat rekening).
- Saat nomor rekening diubah tanpa memilih kode: tampilkan teks bantuan bahwa kode bank akan dikosongkan dan gaji transfer tertahan sampai diisi.
- Teks UI baru didaftarkan ke katalog; `node --test tests/text-contract.test.mjs`.
- Test komponen/route yang ada untuk dialog itu diperbarui; screenshot lebar sempit dan lebar (subagent) ke `docs/screenshots/652-*`.
- `bd update legend-jazlx --status review` + `bd comment`.

## Review
Tingkat S: satu subagent `reviewer` sonnet, plus `ui-auditor` untuk dialog.

## Bukti selesai
Test terarah web lewat `heavy`, typecheck web sekali lewat `heavy`, prettier + eslint, text-contract. Push tanpa force.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Maks 3 subagent.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
