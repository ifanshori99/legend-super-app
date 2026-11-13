# Brief: engineer — anti pecah kas keluar dihitung lintas outlet (founder Q18)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang: "jangan sampai rugi".

## Konteks
Founder Q18 (13 Nov): batas persetujuan kas keluar (Q7, batas tenant Rp5 jt) dan anti pecah dihitung LINTAS OUTLET: total per pembuat per hari di semua outlet, termasuk entri tanpa outlet. Kode sekarang (dari `fix/petty-fund-required`, sudah di m1 sebagai migrasi `0332_cash_limit_antisplit`) menghitung per outlet.

## Repo
Worktree baru dari `milestone/m1` (1cbb842d5): `git worktree add .worktrees/antisplit-649 -b fix/cash-antisplit-cross-outlet milestone/m1`, `pnpm worktree:setup`. Rentang migrasi bila perlu: **0518-0519** (jangan ubah 0332 yang sudah diterapkan; buat migrasi baru).

## Kerja
- Test gagal-dulu: pembuat sama, hari sama, outlet A Rp3 jt + outlet B Rp3 jt -> kedua entri `pending_approval` (bukan langsung lolos). Tambah: entri tanpa outlet ikut dihitung; pembuat beda tidak saling menjumlah; hari beda tidak menjumlah; tenant lain tidak ikut.
- Ubah perhitungan (service dan/atau fungsi/indeks DB) jadi per tenant + pembuat + hari kalender tenant, semua outlet. Konkurensi: dua submit bersamaan di outlet berbeda tidak boleh lolos berdua (kunci per tenant+pembuat+hari).
- `bd create` kartu untuk ini bila belum ada, lalu `bd update --status review` + `bd comment` di akhir.

## Review
Tingkat K (uang + migrasi): satu subagent `architect`, "architect effort xhigh"; maks 2 ronde.

## Bukti selesai
Test terarah lewat `heavy` (termasuk test kas yang ada), typecheck api lewat `heavy` sekali, prettier + eslint, `db:generate` kosong, `node --test` registry migrasi bila ada migrasi. Push tanpa force.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Hemat token.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
