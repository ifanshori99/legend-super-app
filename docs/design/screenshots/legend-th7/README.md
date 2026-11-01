# legend-th7 · Denah & Meja screenshots

Evidence for bead `legend-th7` (PRD v1.7 §3 F9 "Denah & Meja"), captured from the
web app in mock mode (`VITE_API_MOCK=true`, role cookie `legend-mock-role=all`) on a
Vite dev server. Screens: `/kelola/meja` (floor editor) and `/kelola/meja/qr`
(QR labels). Light theme is white; dark theme uses the `.dark` tokens.

## Floor editor — `/kelola/meja`

| File                          | What it shows                                                        |
| ----------------------------- | -------------------------------------------------------------------- |
| `meja-390-light.png`          | Phone, light: zone filter, plan, table inspector, zone list           |
| `meja-390-dark.png`           | Phone, dark                                                          |
| `meja-1440-light.png`         | Desktop, light: plan + inspector side by side, zone table below       |
| `meja-1440-dark.png`          | Desktop, dark                                                        |
| `meja-inspector-390-light.png` | Phone: selected table — position, size, shape, number, zone, status  |
| `meja-zona-390-light.png`     | Phone: zone list (pay mode, service charge, minimum spend, hours)     |
| `meja-dirty-1440-light.png`   | Unsaved plan changes banner + primary "Simpan denah"                  |
| `zona-form-1440-light.png`    | Zone settings dialog: pay mode, service charge, min spend, hours      |
| `zona-form-390-dark.png`      | Zone settings as a bottom sheet on a phone (sticky footer)            |
| `tambah-meja-1440-light.png`  | Add-table dialog with the suggested number and free-slot placement    |
| `hapus-zona-1440-light.png`   | Delete-zone confirmation refuses a zone that still holds tables (409) |

## QR labels — `/kelola/meja/qr`

| File                       | What it shows                                                     |
| -------------------------- | ----------------------------------------------------------------- |
| `qr-390-light.png`         | Phone, light: table list with search, zone filter, selection       |
| `qr-1440-light.png`        | Desktop, light                                                    |
| `qr-labels-390-dark.png`   | Issued labels on a phone in dark mode: QR, number, zone, URL       |
| `qr-print-preview-390.png` | `@media print` preview: only the label sheet, forced light theme   |

## Empty and error states

Each screen also has `*-empty-*` (no zones/tables yet, with the next action) and
`*-error-*` (load failure with "Coba lagi") in 390 + 1440, light and dark.

Regenerate with a dev server on port 3243:

```bash
WEB_URL=http://localhost:3243 VITE_API_MOCK=true DEPLOYMENT_MODE=development \
  DATA_CLASSIFICATION=synthetic VITE_API_MOCK_LATENCY_MS=0 PORT=3243 \
  pnpm --filter @starter/web dev
```
