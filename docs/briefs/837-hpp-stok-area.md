# Brief: engineer — area HPP, stok, inventori (5 kartu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`, cabang `ws/hpp-stock-followups`.

## Kartu
legend-wa9k9 (rebuild HPP merek dalam satu transaksi), legend-8qm1d (`cost_snapshot_idr` dan retur stok), legend-xtuik (HPP dan lokasi nonaktif), legend-1qyx (index `stock_ledger`), legend-uloj6 (rata-rata bergerak retur supplier). Baca tiap kartu dengan `bd show`. Cek dulu `git log --all --grep <id>`: yang sudah dikerjakan dilaporkan, jangan diulang. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`.

## Aturan
- Menyentuh uang (HPP, nilai stok): test wajib membuktikan nilai persediaan dan HPP tidak menggelembung atau hilang dan outlet tidak rugi (retur tidak menghasilkan nilai lebih dari yang dibayar).
- Migrasi hanya untuk legend-1qyx, satu berkas, nomor sementara 0383 (merge train yang menomori ulang). Tanpa migrasi lain.
- Ragu soal aturan bisnis: berhenti dan lapor ke CTO dengan pilihan.

## Pembagian paralel (giliran pertama)
Explore (2): HPP merek + snapshot; retur stok/supplier + ledger. test-writer: test gagal-dulu per kartu. implementer: satu per kartu, file tidak bertumpuk. Satu pemegang heavy (test-runner). Review akhir: subagent architect effort xhigh (uang).

## Bukti selesai
Test terarah hijau lewat heavy, pra-gate AGENTS.md, `pnpm db:generate` kosong, push tanpa force, laporan dengan sha, test merah-dulu, dan angka subagent.
