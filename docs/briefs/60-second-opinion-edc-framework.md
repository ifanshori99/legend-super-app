# Brief: second-opinion — framework agent EDC di edge (legend-apt)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edc-framework`, cabang `ws/edc-framework` (HEAD `5f797fe`). Diff: `git diff main...ws/edc-framework` (abaikan snapshot drizzle `meta/*.json` yang besar). Brief engineer asal: `docs/briefs/23-engineer-edc-framework.md`.

## Fokus (area uang)
- Nominal integer IDR, tidak pernah float, di semua jalur request bayar, cancel, dan status inquiry.
- Timeout dan koneksi putus menghasilkan status "unknown", bukan "gagal". Status inquiry wajib sebelum retry; tidak ada tagihan ganda.
- Idempotensi request bayar dan cancel bila diulang atau dipanggil bersamaan. Cancel setelah approve tidak membatalkan transaksi yang sudah tercatat.
- Simulator ECR: hanya aktif di test dan dev; tidak bisa terpasang di production.
- Registry provider per bank: provider tidak dikenal ditolak; kredensial bank tidak ada di repo atau log.
- Race antara response bank yang terlambat dan inquiry: status akhir konsisten.
- Bila ada tabel: `tenant_id NOT NULL`, RLS enforced, `outlet_id`; isolasi lintas tenant dan outlet diuji.
- Test benar-benar membuktikan klaim: approve, decline, timeout, cancel, inquiry setelah timeout (tidak dobel). Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
