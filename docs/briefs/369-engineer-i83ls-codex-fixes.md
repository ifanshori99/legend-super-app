# Brief: engineer — perbaikan temuan Codex i83ls-fix (legend-44g8n)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (uang + migrasi): satu subagent architect review.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/i83ls-fix`, cabang `ws/i83ls-fix` (3b3e2be3). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Ikuti `bd show legend-44g8n`: (1) kembalikan `0229_order_issue_refund_rejected.sql` ke isi sebelum 5558eca2..3b3e2be3 mengubahnya, dan pindahkan perubahan kolom/constraint/index ke migrasi forward baru nomor 0244; (2) idempotensi `collect-at-pos` terserialisasi (kunci per shift+key, atau petakan 23505 ke 409 `IDEMPOTENCY_KEY_REUSED`).

## Kartu
`legend-44g8n`. `ghostex board associate legend-44g8n`, `bd update legend-44g8n --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh diubah: migrasi 0229 (kembalikan), migrasi baru 0244, `order-recovery-charge-pos.ts`, test.
- Jangan disentuh: modul lain. `when` 0244 unik dan lebih tinggi dari semua `_journal.json` di `.worktrees/*`.

## Bukti selesai
- Test gagal-dulu: DB yang sudah menjalankan 0229 lama lalu migrate -> kolom ada; dua request konkuren key sama -> satu 201, satu 409 (bukan 500).
- Typecheck dan test terarah lewat `heavy`. Architect review.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Laporan
SHA, test gagal-dulu, nilai `when`, temuan review, risiko.
