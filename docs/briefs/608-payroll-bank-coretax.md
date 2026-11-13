# Brief: engineer — file transfer bank + ekspor Coretax PPh 21

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (sudah dibuat Ghostex). Push cabang kerja ke `origin` sebagai `ws/payroll-bank-coretax`.

## Kartu
`legend-34qx` (layout file transfer bank untuk gaji + format ekspor Coretax PPh 21).
Cek dulu tiap kartu belum dikerjakan di basis; bila sudah, tutup dengan bukti. Di awal `bd update <id> --status in_progress`; lapor `--status review` + `bd comment <id> "<ringkasan>"`. Detail: `bd show <id>` dan PRD di `docs/prd/`.

## Tujuan dan aturan
Ekspor hanya membaca hasil payroll yang sudah dikunci (run lock); tidak mengubah nominal. Total file = total gaji bersih run, per karyawan tepat; pembulatan sesuai aturan payroll yang ada. Data pribadi (rekening, NPWP/NIK) hanya ke pengguna berizin payroll, tidak ke log. Format bank: mulai dari bank yang sudah ada di PRD/kode; bila PRD tidak menyebut, buat lapisan format yang bisa ditambah + satu format CSV generik, dan catat di laporan. Coretax: format resmi DJP (cari dokumentasi resmi; bila tidak pasti, catat asumsi).

## Scope
Boleh: service/route ekspor payroll, kontrak shared, test.
Migrasi: hanya rentang `0453-0455`. Jangan rahasia nyata; nama key dari `.env.example`. Jangan sentuh uang/QRIS/AI/edge darurat kecuali disebut.

## Pembagian paralel (giliran pertama)
Explore 2 (peta kode per kartu), test-writer (test gagal-dulu), implementer satu per kartu/potongan file (tidak bertumpuk), review: satu `architect` effort xhigh (uang, pajak, data pribadi), satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck paket yang berubah via `heavy`; `db:generate` kosong bila ada migrasi; pra-gate AGENTS.md (prettier, eslint, text-contract bila teks baru).

## Batas
Jangan `pkill`; jangan merge ke milestone/m1; jangan deploy. Jam dari `date '+%H:%M'`. tsc gagal identik 2x: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis.

## Laporan
Hasil, bukti, commit, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
