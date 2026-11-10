# Brief 98: workstream WS-01 platform (tenant, akun, izin, setelan). Auth dan izin tingkat K.

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`, lalu ikuti template itu: fan-out di giliran pertama.

Kartu: ambil kartu siap berlabel `ws-01` (`bd list --status open --json`), prioritas tertinggi dulu, maksimal 12.

Lewati:
- kartu deferred;
- kartu frontend yang mockupnya belum disetujui founder (cek `docs/PROGRESS.md`);
- kartu yang bergantung pada cabang yang belum digabung (lihat tabel v3.3 di PROGRESS).

Basis: worktree `.worktrees/ws-01-ws`, cabang `ws/ws-01-ws` dari `milestone/m1` terbaru.

Batas: `heavy pnpm check` penuh sekali di akhir, jalankan di latar.

Commit lokal saja. Laporan mengikuti template.
