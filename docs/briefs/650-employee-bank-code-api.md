# Brief: engineer — API HR isi `employees.bank_code` (legend-86he4)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area data pribadi + gaji: "jangan sampai rugi".

## Konteks
Kanal gaji manual BCA (`ws/payroll-disbursement-manual` 5c73da044, migrasi 0516 menambah `employees.bank_code`) menandai semua item `bank_code_missing` karena tidak ada API yang mengisi kolom itu. Hanya kode `014` (BCA) yang diterima kanal manual sekarang.

## Repo
Worktree dari `origin/ws/payroll-disbursement-manual`: `git worktree add .worktrees/bankcode-650 -b fix/employee-bank-code origin/ws/payroll-disbursement-manual`, lalu `pnpm worktree:setup`. Migrasi hanya bila perlu, rentang **0520-0521**.

## Kerja
- Tambah `bank_code` ke validator zod karyawan (create/update) di `packages/shared` dan DTO, serta ke service dan route HR yang sudah mengisi rekening karyawan. Ikuti izin dan scope tenant/outlet yang dipakai field rekening.
- Validasi: kode bank 3 digit dari daftar tetap; boleh null. Rekening tanpa kode bank tetap boleh disimpan (tunai fallback Q10).
- Audit log perubahan sama seperti field rekening. Jangan log nomor rekening.
- Test gagal-dulu: isi dan ubah `bank_code`; tenant lain tidak bisa; kode tidak valid 422; item batch manual tidak lagi `bank_code_missing` setelah diisi.
- `bd update legend-86he4 --status review` + `bd comment` di akhir.

## Review
Tingkat K (data pribadi): satu subagent `architect` effort high, maks 2 ronde.

## Bukti selesai
Test terarah lewat `heavy`, typecheck api sekali lewat `heavy`, prettier + eslint, teks UI baru (bila ada) lewat `node --test tests/text-contract.test.mjs`. Push tanpa force.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Hemat token: tugas kecil, maks 3 subagent.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
