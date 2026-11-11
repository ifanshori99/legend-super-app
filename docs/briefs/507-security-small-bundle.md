# Brief: engineer — dua celah akses kecil

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Langkah 0: `git -C <repo> fetch origin milestone/m1 ws/approvals-rbac-bundle && git -C <repo> worktree add .worktrees/sec-small -b ws/sec-small origin/ws/approvals-rbac-bundle` (basis cabang WS-01 386d490c karena oaj3e memakai registri token di sana). PORT dan DB sendiri. Tanpa migrasi.

## Kartu
- `legend-6vnbh` (P1): API menolak mematikan email kategori security (`isEmailMandatory`) di server (sekarang hanya mock web yang menolak). 422 + pesan jelas.
- `legend-oaj3e` (P2): `/verify` di `device-pin.routes.ts:99` dan `hris-attendance.routes.ts:236` juga cek token terhadap registri (`devices.token_issued_at`), seperti route POS lain di 386d490c. Token lama setelah rotasi = 401.
Di awal `bd update <id> --status in_progress`; selesai `--status review` + `bd comment`.

## Paralel
test-writer (fail-first kedua kartu) + 2 implementer paralel (file terpisah), reviewer sonnet di akhir. Satu pemegang heavy.

## Bukti
Fail-first per kartu, test terkait `heavy`, tsc api (heap default heavy), eslint, prettier. Commit per kartu, push `ws/sec-small`. Laporan: sha, bukti, angka subagent.
