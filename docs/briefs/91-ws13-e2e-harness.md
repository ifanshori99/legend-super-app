# Brief 91: workstream WS-13 QA, alur A–Z dimulai sekarang

Peran: qa/test-writer. Baca `~/.agents/team/roles/qa.md` (atau `test-writer.md`) dan `docs/briefs/_TEMPLATE-workstream.md`, lalu ikuti template itu: fan-out di giliran pertama.

Kartu (`bd show <id>`): legend-hmz2, legend-o2on, legend-612c, dan kartu WS-13 lain yang siap (`bd list --status open | grep WS-13`).

## Tujuan
Tes alur bisnis A–Z ditulis dan berjalan di `milestone/m1` jauh sebelum rilis. Sumber kebenarannya PRD (`docs/PRD.md`), bukan kode.

Alur yang dicakup:
- Pesan via QR, lalu bayar QRIS/VA/kartu online lewat DOIT (pakai mock).
- Kasir: shift buka, tunai/EDC, refund/void, tutup shift.
- Dapur (KDS).
- Stok opname, lalu jurnal.
- Payroll dan cuti.
- Reservasi.
- Whitelabel per tenant.

Metode pembayaran rilis: QRIS, VA, kartu, tunai, EDC. Tidak ada transfer bank.

## Aturan
- Fitur yang belum digabung ke m1: tulis skenarionya sekarang, tandai skip dengan id cabang. Aktifkan begitu merge train menggabungkan cabang itu.
- Playwright dan e2e lewat `heavy`. Dev server maks 2 di seluruh Mac. Gunakan PORT dan nama DB sendiri.

Basis: worktree `.worktrees/e2e-az`, cabang `ws/e2e-az` dari `milestone/m1`.

Commit lokal saja. Laporan mengikuti template, ditambah daftar alur: lulus, gagal (bug produk ditulis sebagai kartu bd P1), atau skip.
