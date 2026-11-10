# Brief: WS-11 keluarga F2, F3, F4

Ikuti `docs/briefs/268-ws11-family-common.md` sepenuhnya.

| Kartu | Keluarga | Laporan | Tingkat | Migrasi |
|---|---|---|---|---|
| legend-a82g9 (F2) | `traffic-operations` | `traffic.*` (5) + `operations.*` (9), serap legend-u21j, 14 route generik | S | tidak |
| legend-e58wz (F3) | `menu-cogs` | `menu.*` (7) + `cogs.*` (4), `cogs.per_menu` pecahan dari pesanan dengan GL sebagai kontrol | K | tidak |
| legend-hpc4s (F4) | `payments-tax` | `payments.*` (6) + `tax.*` (4), `payments.methods` dari pesanan dengan GL sebagai kontrol | K | tidak |

Tiga implementer paralel, satu per keluarga. Review: satu `architect` untuk F3 + F4, satu `reviewer` untuk F2. Brief Codex: `docs/briefs/268ab-second-opinion-ws11-menu-payments.md`.
