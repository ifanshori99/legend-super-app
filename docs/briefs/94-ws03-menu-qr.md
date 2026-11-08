# Brief 94: workstream WS-03, menu dan QR order

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`, lalu ikuti template itu: fan-out di giliran pertama.

## Kartu
Ambil kartu siap WS-03 (`bd list --status open --json`, saring label `ws-03`, prioritas tertinggi dulu), maksimal 12 kartu.

Lewati:
- Kartu frontend yang mockupnya belum disetujui founder (cek `docs/PROGRESS.md`).
- Kartu yang bergantung pada cabang yang belum digabung: recipe-bom, kds, pos-receipt, print-agent.

## Aturan
- Metode bayar online saat rilis: QRIS dan VA lewat DOIT. Di kasir: tunai, EDC, QRIS.
- Tidak ada transfer bank.
- Kartu online masih menunggu keputusan founder. Jangan dibangun.
- Basis: worktree `.worktrees/ws03-menu`, cabang `ws/ws03-menu` dari `milestone/m1` terbaru.
- Commit lokal saja.
- Laporan mengikuti template.
