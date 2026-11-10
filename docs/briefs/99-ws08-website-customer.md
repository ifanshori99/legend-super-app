# Brief 99: workstream WS-08, website brand dan pelanggan

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`, lalu ikuti template itu: fan-out di giliran pertama.

## Kartu
Mulai dari legend-qgr6 (P1). `GET /api/public/site` belum ada, sehingga website brand di `/` selalu menampilkan WebsiteError. Manifest whitelabel di `ws/fix-whitelabel` juga memakai `getPublicSite`.

Setelah itu ambil kartu siap berlabel `ws-08` (`bd list --status open --json`), maksimal 12 kartu.

Lewati kartu frontend yang mockupnya belum disetujui founder. Status mockup ada di `docs/PROGRESS.md`; Q6 pelanggan masih "UBAH DULU".

## Aturan
- Whitelabel (TEN-08): nama platform tidak boleh muncul di domain tenant.
- Data pelanggan adalah data pribadi, tingkat K.
- Basis: worktree `.worktrees/ws08-site`, cabang `ws/ws08-site` dari `milestone/m1` terbaru.
- Commit lokal saja.
- Laporan mengikuti template.
