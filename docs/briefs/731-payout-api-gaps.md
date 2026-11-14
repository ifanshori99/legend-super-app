# Brief: engineer (Claude Opus) — celah API payout (legend-zoqh1, legend-2bl54, legend-396pf)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show <id>` untuk tiap kartu.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ws/payout-api-gaps .worktrees/payout-api-gaps origin/milestone/m1`. Konsumen UI: cabang `ui/payout-finance-exceptions` (menunggu review founder; jangan ubah UI-nya, catat kebutuhan wiring sebagai kartu).

## Tujuan (satu area, satu implementer per kartu, file dipisah)
1. legend-zoqh1 (P1, uang): endpoint unggah bukti untuk resolve gagal/tidak terkirim dan return. Menghasilkan key `tenants/<tenant>/payroll-payout/<batch>/<file>`; service memvalidasi key milik tenant dan batch yang sama (tidak bisa memakai bukti batch lain). Tipe dan ukuran file dibatasi. Pakai adapter penyimpanan yang sudah ada (lihat `uploadMenuImage`); jangan membuat transport media umum (itu legend-0una).
2. legend-2bl54: item batch membawa snapshot `accountHolderName` dan `maskedAccountNumber` yang dikunci saat batch dibuat (bukan data karyawan terkini). Nomor rekening penuh tidak pernah keluar di DTO.
3. legend-396pf: `GET /payout-batches?legalEntityId=&status=` dengan paginasi, dibatasi permission dan tenant.
Migrasi bila perlu (snapshot kolom): nomor 0600-0602, generate lewat `pnpm db:generate`, jangan sentuh migrasi lama.

## Tingkat dan review
Tingkat K (uang, akses, data pribadi, migrasi). Test gagal-dulu wajib: bukti batch lain ditolak, tenant lain ditolak, DTO tidak bocor nomor penuh, snapshot tidak berubah setelah rekening karyawan diganti, tidak ada jalur yang membuat pembayaran ganda. Review: satu subagent `architect` effort xhigh pada diff akhir; temuan nyata dibetulkan sebelum lapor.

## Bukti, sebelum melapor
Test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, migrasi `pnpm db:generate` kosong, typecheck api+web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (sertakan angka subagent). Commit lokal, push cabang tanpa force. Jangan merge, jangan deploy.
