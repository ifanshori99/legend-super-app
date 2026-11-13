# Brief: engineer — pembatalan link bayar mengikuti penyedia (DP reservasi, sarapan, recovery)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/qris-dp-hold` (sudah dibuat Ghostex). Push cabang kerja ke `origin` sebagai `ws/payment-link-cancel`.

## Kartu
`legend-ukbq3` (pembatalan link bayar lokal mengabaikan penyedia: reservation-lifecycle.ts:532, facility-breakfast-money.ts:405, order-recovery-charge*.ts; pembayaran terlambat jadi refund).
Cek dulu tiap kartu belum dikerjakan di basis; bila sudah, tutup dengan bukti. Di awal `bd update <id> --status in_progress`; lapor `--status review` + `bd comment <id> "<ringkasan>"`. Detail: `bd show <id>` dan PRD di `docs/prd/`.

## Tujuan dan aturan
Terapkan pola hold/bukti dari QRIS ber-DP (legend-yhia9 C2, cabang basis ws/qris-dp-hold): sebelum batal lokal, cek/batalkan di penyedia; bila penyedia sudah menerima uang, jangan batal: terapkan pembayaran atau parkir sekali di dana tak teralokasi (founder Q93). Test uang wajib: tidak ada pihak dibayar lebih, tidak ada refund ganda, outlet tidak rugi. Tanpa kunci penyedia nyata: mock gateway.

## Scope
Boleh: tiga service di atas + helper bersama payment link, test. Jangan ubah logika QRIS hold yang sudah ada kecuali mengekstrak helper bersama.
Migrasi: hanya rentang `0459-0461`. Jangan rahasia nyata; nama key dari `.env.example`. Jangan sentuh uang/QRIS/AI/edge darurat kecuali disebut.

## Pembagian paralel (giliran pertama)
Explore 2 (peta kode per kartu), test-writer (test gagal-dulu), implementer satu per kartu/potongan file (tidak bertumpuk), review: satu `architect` effort xhigh (uang), satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck paket yang berubah via `heavy`; `db:generate` kosong bila ada migrasi; pra-gate AGENTS.md (prettier, eslint, text-contract bila teks baru).

## Batas
Jangan `pkill`; jangan merge ke milestone/m1; jangan deploy. Jam dari `date '+%H:%M'`. tsc gagal identik 2x: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis.

## Laporan
Hasil, bukti, commit, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
