# Brief: engineer — POS/EDC kecil (5 kartu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi (bila ternyata perlu: rentang 0698-0699, pakai `--full`).

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`. Baca `bd show` tiap kartu untuk AC.
1. `legend-puzmg` alasan void + pill "Dikembalikan" (queue-list.tsx:100).
2. `legend-2l4s8` banner antrean terpotong (edc-reconciliation/queries.ts:17).
3. `legend-xb20o` void QRIS dua tender (pos-order-payment.ts:141) — uang: test bahwa tidak ada tender yang dikembalikan dua kali dan total kembali <= total dibayar.
4. `legend-376ob` reprice mode pajak (pos-order-support.ts:1167) — uang: test total tidak berubah salah arah.
5. `legend-2z04` sisa pola PAN di test.

## Aturan
- Cek tabrakan dulu: `git diff --stat origin/milestone/m1...origin/int/batch90` dan cabang edge `ws/1073-*` (EDC agent di apps/api/src/edge). File yang disentuh batch90: tunda kartu itu dan laporkan.
- Uang: bila ragu, pilih yang membatasi pembayaran/pengembalian.
- Teks UI baru: daftarkan ke katalog text-contract.

## Pembagian paralel
- Explore (1): tabrakan file dengan int/batch90 + peta file kartu.
- test-writer (1): test gagal-dulu kartu 3 dan 4.
- implementer per kartu (file terpisah).
- test-runner: pemegang token heavy (setup, test terarah, typecheck API + web sekali).
- architect (effort high; xhigh bila menyentuh jumlah uang): review diff kartu 3-4. reviewer sonnet: kartu 1, 2, 5.

## Bukti selesai
Test terarah lulus, merah-dulu kartu 3-4 tercatat, typecheck API + web lulus, text-contract lulus bila teks berubah.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Matikan dev server/browser milikmu.

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1085-pos-edc-kecil`, push tanpa `--force`.

## Laporan
Hasil per kartu, bukti, berkas, commit, cabang, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
