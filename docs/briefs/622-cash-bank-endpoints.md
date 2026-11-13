# Brief: engineer — Kas & Bank endpoint nyata + re-issue tiket akses

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + migrasi + akses). Desain posting baru: mulai dengan satu subagent `architect` effort xhigh untuk desain singkat sebelum implementer.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/settlement-recon` (52346c44; area ws07 sudah tersentuh di sana). Push ke `origin` sebagai `ws/cash-bank`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>`)
1. `legend-4961`: endpoint nyata kas masuk/keluar, kas kecil per outlet, transfer antar-rekening, dengan aturan posting jurnal (debit = kredit, akun dari peta akun; peta hilang -> parkir `ACCOUNT_MAPPING_MISSING`, jangan tebak). Kontrak `packages/shared/src/accounting/banking.ts`, route accounting API, sambungkan `apps/web/.../ws07-cash-bank` dari mock ke API.
2. `legend-gq0w`: endpoint re-issue QR/PIN tiket akses yang diaudit dan dibatasi laju (`packages/shared/src/facility`). Cek ketergantungan auth `legend-x1yh`; bila terblokir, kerjakan kartu 1 saja dan laporkan.

Jangan sentuh payroll, QRIS, settlement import.

## Migrasi
Rentang `0484-0485` saja. `db:generate` kosong setelahnya.

## Aturan uang (founder)
Test gagal-dulu: transfer antar-rekening seimbang dan idempoten (kirim ulang tidak dobel); kas kecil tidak bisa minus melebihi saldo; pengguna tanpa izin/outlet lain ditolak; tidak ada uang tercatat dua kali.

## Pembagian paralel
architect (desain, xhigh), test-writer, implementer 3 (API kas/bank; web wiring; tiket akses), architect xhigh atas diff akhir, `ui-auditor` atas layar ws07, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck sekali di akhir. Screenshot 390 dan 1280 di `docs/screenshots/cash-bank/`.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
