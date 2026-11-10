# Brief: second-opinion — kunci tutup periode fiskal (legend-72we, legend-xm30)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Cabang `ws/fiscal-close-lock`, HEAD `bfe16fb` (fitur `03dd8b3` + fix review architect `bfe16fb`). Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/fiscal-close-lock` bila ada; bila tidak, baca lewat `git diff main...ws/fiscal-close-lock` dari checkout utama tanpa checkout cabang.

## Fix architect yang sudah masuk (verifikasi juga)
FOR UPDATE di legal_entities diganti FOR NO KEY UPDATE / FOR SHARE supaya insert FK tidak terblokir; snapshot inkremental; `lock_timeout`; urutan buka ulang; status snapshot.

## Fokus (uang/akuntansi)
- Urutan kunci konsisten di semua jalur: legal_entities (NO KEY UPDATE / KEY SHARE) → periode → request. Cari deadlock dan jalur yang membalik urutan.
- Jalur posting jurnal yang melewati kunci (posting langsung, worker, import, koreksi, reversal): bisa menulis ke periode yang sedang/sudah ditutup?
- Snapshot saldo saat tutup: konsisten dengan posting yang commit bersamaan; inkremental benar.
- `PERIOD_CLOSED` untuk posting back-dated ke periode tertutup: ditolak di semua jalur, termasuk tanggal batas dan zona waktu.
- Approval buka ulang: wajib, sekali pakai, tidak lintas entitas/tenant; jejak audit.
- Idempotensi close/reopen bila diulang atau dipanggil bersamaan.
- RLS: isolasi tenant dipaksa pada tabel baru.
- Migration `0063_fiscal_close_lock`, `0064_fiscal_close_lock_rls`: aman untuk data lama. Nomor yang bentrok dengan cabang lain dirapikan saat merge; itu bukan temuan.
- Test benar-benar membuktikan klaim (race diuji dengan transaksi bersamaan). Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. Tandai apakah tiap fix architect benar-benar menutup masalahnya. "Tidak ada blocker" bila memang tidak ada.
