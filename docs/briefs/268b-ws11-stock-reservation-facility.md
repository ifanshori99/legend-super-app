# Brief: WS-11 keluarga F5, F8, F10

Ikuti `docs/briefs/268-ws11-family-common.md` sepenuhnya.

| Kartu | Keluarga | Laporan | Tingkat | Migrasi |
|---|---|---|---|---|
| legend-e12h5 (F5) | `inventory-purchasing` | `inventory.*` (7) + `purchasing.*` (5); pindahkan helper `ai-metrics` stok ke registry (DECISIONS) | K | tidak |
| legend-lqf0j (F8) | `reservation-delivery` | `reservation.*` (4) + `delivery.*` (4), 4 route generik. Sinkron platform delivery sedang diubah di `ws/delivery-platform-retry` (legend-r7vxn): baca data pesanan delivery yang sudah ada di basis, jangan ubah service delivery | K | tidak |
| legend-60tsm (F10) | `facility` | `facility.*` (11) + 19 metrik fasilitas; `web/features/facility-report` memakai registry yang sama (DECISIONS risiko 2) | K | tidak |

Tiga implementer paralel, satu per keluarga. Review: satu `architect` untuk diff gabungan. Brief Codex: `docs/briefs/268bb-second-opinion-ws11-stock-reservation-facility.md`.
