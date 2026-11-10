# Brief 97: workstream WS-09 fasilitas dan Wi-Fi (tanpa smart lock dan kamar mandi, yang ditunda founder). Wi-Fi masuk rilis pertama; kartu EXT pemilihan vendor (legend-6ybb) masih menunggu pihak luar, jadi bangun lewat interface provider + simulator.

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`, lalu ikuti template itu: fan-out di giliran pertama.

Kartu: ambil kartu siap berlabel `ws-09` (`bd list --status open --json`), prioritas tertinggi dulu, maksimal 12.

Lewati:
- kartu deferred;
- kartu frontend yang mockupnya belum disetujui founder (cek `docs/PROGRESS.md`);
- kartu yang bergantung pada cabang yang belum digabung (lihat tabel v3.3 di PROGRESS).

Basis: worktree `.worktrees/ws-09-ws`, cabang `ws/ws-09-ws` dari `milestone/m1` terbaru.

Batas: `heavy pnpm check` penuh sekali di akhir, jalankan di latar.

Commit lokal saja. Laporan mengikuti template.
