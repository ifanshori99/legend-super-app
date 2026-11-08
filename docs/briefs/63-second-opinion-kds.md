# Brief: second-opinion — KDS routing dan siklus tiket (legend-4d5)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/kds`, cabang `ws/kds` (HEAD `4a1f613`). Diff: `git diff main...ws/kds` (abaikan snapshot drizzle `meta/*.json` yang besar). Brief engineer asal: `docs/briefs/22-engineer-kds.md`. Konflik merge diperkirakan dengan `ws/pos-shift` pada `pos-order.service.ts`.

## Fokus (auth, data pribadi, konsistensi)
- Otorisasi stasiun: `requireStationPermission`, `assertStationPermission`, `permittedStationIds`. Stasiun tidak dikenal ditolak; stasiun di luar hak pengguna tidak bisa dibaca atau diubah; tidak ada jalur route yang melewati helper.
- Isolasi lintas tenant, outlet, dan stasiun pada tiket, transisi status, dan WebSocket resync.
- State machine tiket: transisi ilegal ditolak; tiap transisi punya timestamp dan jejak audit; dua update bersamaan tidak membuat status mundur.
- Resync berbasis sequence saat reconnect: tanpa tiket hilang, tanpa duplikat; sequence tidak bisa dipalsukan klien lintas tenant.
- Routing order POS ke stasiun: pemetaan menu konsisten; order yang dibatalkan atau dibayar ulang tidak membuat tiket ganda.
- Payload WebSocket hanya memuat data yang boleh dilihat stasiun tersebut.
- RLS enforced (ENABLE + FORCE + policy `tenant_id = app.require_tenant_id()`) pada tabel baru; unique constraint menyertakan `tenant_id`.
- Migration aman untuk data lama. Nomor migration yang bentrok dengan `ws/pos-shift` dan `ws/pos-payment-fixes` dirapikan saat merge; itu bukan temuan.
- Test benar-benar membuktikan klaim (KDS-01..04). Boleh reproduksi dengan DB sementara (`~/.claude/scripts/colima-up`), bersihkan sesudahnya.

## Laporan
Temuan urut paling berat: file:baris, masalah, skenario gagal konkret, fix. "Tidak ada blocker" bila memang tidak ada.
