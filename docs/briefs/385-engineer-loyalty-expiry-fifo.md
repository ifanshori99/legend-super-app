# Brief: engineer — expiry poin loyalty FIFO (legend-w5by9)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Tingkat K (poin = nilai uang): satu subagent architect xhigh review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. `git worktree add .worktrees/w5by9-expiry -b ws/w5by9-expiry-fifo milestone/m1` (1b1e96eb). PORT dan nama DB sendiri. Push cabang kerja tiap commit; jangan push main, jangan --force.

## Tujuan
Temuan Codex 383, P1, `apps/api/src/services/loyalty-expiry.service.ts:151`: redeem lama dialokasikan ulang ke grant yang lebih baru. Contoh: grant A 100 -> redeem 100 -> grant B 100 dengan expiry B lebih awal dari A. Saat B kedaluwarsa, sistem menghapus 0 poin, seharusnya 100 (redeem sudah memakai A).
Fix pilihan engineer, dengan alasan di laporan:
- proses riwayat ledger menurut `posting_seq` (redeem hanya memakan grant yang sudah ada saat redeem, FIFO menurut expiry di antara grant itu), atau
- simpan alokasi grant saat redeem (tabel/kolom alokasi) dan expiry membaca alokasi itu.
Pembalik redeem (refund) dan kedaluwarsa parsial harus tetap konsisten; saldo = jumlah ledger.

## Scope
- Boleh: `loyalty-expiry.service.ts`, `point-ledger.service.ts` bila perlu, test-nya.
- Jangan: `loyalty-earn-consumer.ts` kecuali wajib; bill-split dan table-claim (thread lain).
- Migrasi bila wajib: 0254 saja, `when` lebih tinggi dari semua `_journal.json` di `.worktrees/*`.

## Bukti
- Test gagal-dulu dengan contoh di atas + variasi (redeem parsial, refund redeem, dua grant expiry sama).
- `heavy` typecheck api (EXIT eksplisit), test loyalty terkait. Batas Retro 11: 2x gagal typecheck, baca log.

## Kartu
`legend-w5by9`: `bd update --status in_progress`, selesai `--status review` + `bd comment`.

## Laporan
SHA, pendekatan dan alasannya, test, hasil typecheck, temuan architect.
