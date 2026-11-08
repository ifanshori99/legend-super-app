# Brief: second-opinion — adapter DOIT PaymentProvider (legend-b9i)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-provider`, cabang `ws/doit-provider` (HEAD `be35d6b`). Diff: `git diff main...ws/doit-provider` (abaikan snapshot drizzle `meta/*.json` yang besar). Brief engineer asal: `docs/briefs/28-engineer-doit-provider.md`.

## Fokus (uang, keamanan, data pribadi)
- Verifikasi webhook `PayBridge-Signature`: tanda tangan salah atau hilang ditolak tanpa efek apa pun (tidak ada perubahan status, tidak ada tulis ke DB). Perbandingan tanda tangan konstan waktu; body mentah yang diverifikasi, bukan hasil parse ulang.
- Simpan-dulu-lalu-proses: dedupe `gateway_webhook_events` per event id; event dobel, urutan terbalik, dan event lama tidak mengubah status yang sudah lebih baru.
- Status dari payload sebagai kebenaran; polling status sebagai cadangan. Polling dan webhook bersamaan tidak membuat status mundur atau nominal ganda.
- Idempotency-Key di tiap request ke DOIT; retry tidak menagih dua kali.
- Nominal integer IDR; selisih nominal antara payload dan order ditolak.
- Kredensial DOIT terenkripsi per tenant; tidak pernah tercetak di log, respons, atau error. Tidak ada kredensial asli di repo.
- Isolasi lintas tenant: webhook dari tenant A tidak bisa mengubah transaksi tenant B.
- Migration aman untuk data lama. Nomor migration yang bentrok dengan cabang lain dirapikan saat merge; itu bukan temuan.
- Test benar-benar membuktikan klaim, memakai server DOIT palsu. Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
