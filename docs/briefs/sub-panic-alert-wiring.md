# Sub-brief: wiring alert panik + pasang di shell fasilitas (legend-jztb7)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/panic-alert-wiring`.
Kontrak (sudah di-merge, jangan ubah): `packages/shared/src/facility/emergency.ts`
(`panicRealtimeFrameSchema` kini punya `unitCode: string|null`, `areaName: string|null`;
baru `panicAcknowledgedFrameSchema` `{type:"acknowledged", alertId, acknowledgedAt, byName}`),
`packages/shared/src/core/errors.ts` (409 `PANIC_ALREADY_ACKNOWLEDGED` membawa
`acknowledgedBy: {displayName}` dan `acknowledgedAt`), dan
`GET /api/emergency/open-alerts` -> `{ data: { alerts: PanicRealtimeFrame[] } }`
(belum di-ack, belum selesai, urut `receivedAt` naik; 401 bila sesi PIN tidak berlaku).
Desain UI Arah A sudah disetujui founder: jangan ubah tata letak/warna. Fitur keselamatan:
alert tidak boleh hilang saat pindah halaman atau muat ulang.

Aturan semua subagent: jangan jalankan tsc/vitest/build/Playwright kecuali disebut
(satu token heavy). Prettier + eslint pada file sendiri boleh. Jangan commit.

## Antarmuka bersama (wajib persis)

### A. `apps/web/src/features/facility-staff/panic-queue.ts`

- `PanicQueueItem` tambah: `unitCode: string|null`, `areaName: string|null`,
  `takenBy: string|null`, `takenAt: string|null` (diisi dari frame; taken* awal null).
- `PanicQueueState` tambah `closedIds: string[]` (alert yang diketahui sudah ditangani
  rekan sebelum muncul di sini); `initialPanicQueue.closedIds = []`.
- Aksi `alert`: diabaikan bila alertId sudah di `items` atau di `closedIds`.
- Aksi baru `{ type: "acknowledged"; frame: PanicAcknowledgedFrame }`:
  - item ada dan `ack` di `idle|failed|session` -> `ack: "taken"`, `takenBy = frame.byName`,
    `takenAt = frame.acknowledgedAt`.
  - item ada dan `ack` `taken` dengan `takenBy` null -> isi takenBy/takenAt.
  - `ack` `sending` atau `mine` -> tidak berubah (hasil POST ack yang memutuskan).
  - item tidak ada -> tambahkan alertId ke `closedIds` (sekali).
- Aksi `ack-taken` tambah field opsional `byName?: string|null`, `at?: string|null` ->
  `takenBy = byName ?? item.takenBy`, `takenAt = at ?? item.takenAt`.
- Aksi baru `{ type: "sync"; alerts: PanicRealtimeFrame[]; knownBefore: string[] }`:
  tiap alert ditambahkan seperti aksi `alert` (urutan array = urutan antrean, dedupe,
  closedIds). Lalu tiap id di `knownBefore` yang item-nya `ack` `idle|failed|session` dan
  TIDAK ada di `alerts` -> `ack: "taken"` (takenBy tetap null = "rekan lain").
  Item `sending`/`mine`/`dismissed` tidak disentuh.
- Fungsi lain (`pendingAlerts`, `settledAlerts`, `panicView`) tetap.

### B. `apps/web/src/features/facility-staff/panic-realtime.ts`

- Frame masuk: coba `panicRealtimeFrameSchema` (perilaku lama: onAlert sekali per id, balas
  `received`), lalu `panicAcknowledgedFrameSchema` -> panggil opsi baru
  `onAcknowledged?(frame)` tiap kali, TANPA balasan. Lainnya diabaikan.
- Opsi baru `apiGet?: (path: string) => Promise<unknown>` (default: `apiFetch(path)` dari
  `@/lib/api/client`, import dinamis seperti `defaultApiFetch`).
- Method baru `openAlerts(): Promise<PanicRealtimeFrame[]>`: GET
  `/api/emergency/open-alerts`, ambil `data.alerts`, parse tiap item dengan
  `panicRealtimeFrameSchema`, buang yang tidak valid. Error dilempar ke pemanggil.
- `ack()` tetap; error 409 dilempar apa adanya (ApiError membawa acknowledgedBy).

### C. `apps/web/src/lib/api/errors.ts` + `client.ts`

- `ApiError` tambah properti opsional `acknowledgedBy?: { displayName: string }` dan
  `acknowledgedAt?: string`, lewat objek `extra` konstruktor (pola `lockedUntil`).
  `client.ts` mengisinya dari body error bila tipenya cocok.

### D. `apps/web/src/features/facility-staff/use-panic-alerts.ts`

- `onAcknowledged: (frame) => dispatch({ type: "acknowledged", frame })`.
- Sinkronisasi: panggil `client.openAlerts()` sekali setelah `start()` dan setiap kali
  status menjadi `"open"`. `knownBefore` = id item pending (idle|failed|session) saat
  permintaan DIMULAI (baca lewat ref state terbaru). Berhasil -> `dispatch sync`.
  Gagal -> diam (WS tetap jalur utama). Jangan sinkron bila hook sudah unmount.
- 409 pada ack -> `dispatch({ type: "ack-taken", alertId, byName: error.acknowledgedBy?.displayName ?? null, at: error.acknowledgedAt ?? null })`.
- Mode mock: `createMockOptions` juga memberi `apiGet` (lihat E).
- Satu klien per mount; hook ini hanya di-mount sekali (lihat F).

### E. Mock (`panic-mock-socket.ts`, `mock.ts`) — hanya VITE_API_MOCK

- Frame mock wajib memuat `unitCode` dan `areaName` (dari fixture `fx` unit P2/W1/P1 dan
  area-nya) — tanpa ini schema strict menolak frame dan mock rusak.
- Registry modul "alert terbuka mock": socket menambah saat mengirim frame panic;
  ack mock (sukses) dan frame acknowledged mock menghapus. `mockPanicOpenAlerts()`
  mengembalikan `{ data: { alerts: [...registry] } }`.
- Skenario baru: `"taken-remote"`: buka, alert 1 di 800 ms, frame
  `{type:"acknowledged", byName:"Rina", acknowledgedAt: now}` di 3 500 ms.
  `"restore"`: registry diisi alert 1 (dan 2) sejak awal, socket buka dan TIDAK
  mengirim frame apa pun (meniru muat ulang: alert hanya bisa datang dari open-alerts).
- 409 mock (`acknowledged`) membawa `acknowledgedBy: {displayName: "Rina"}` dan
  `acknowledgedAt`.

### F. Shell (`routes/_ops/fasilitas.tsx` baru, `emergency-screen.tsx`, `panic-alert-layer.tsx`)

- Layout route `createFileRoute("/_ops/fasilitas")`: `validateSearch` facilityId opsional
  (sama dengan anak), komponen merender `<Outlet />` lalu `<PanicAlertLayer facilityId=… />`
  hanya bila `evaluateGuard({kind:"permission", surface:"pos", anyOf:["facility.access.assist"]}, context.access)`
  `allowed` (tanpa throw; anak punya guard sendiri). Regenerasi `routeTree.gen.ts`
  (router CLI / generator proyek), commit hasilnya.
- Hapus mount `PanicAlertLayer` dari `emergency-screen.tsx` (cegah WS dobel).
- `resolveLocation`: pakai `item.unitCode` / `item.areaName` bila tidak null, fallback
  pemetaan `useUnitBoard` yang ada.
- Kartu/teks "taken": bila `item.takenBy` ada -> "{name} sudah menuju lokasi" (kunci i18n baru
  di `packages/shared/src/i18n/messages/facility-staff.ts`, daftarkan di katalog teks);
  null -> teks lama "rekan lain".

## Test (test-writer, gagal-dulu)

- `tests/panic-alert-queue.test.mjs`: acknowledged (tiap cabang di A), closedIds,
  ack-taken dengan nama, sync (tambah, dedupe, knownBefore -> taken, sending tak disentuh).
- `tests/panic-realtime-client.test.mjs`: frame acknowledged -> onAcknowledged tanpa
  reply; frame panic dengan unitCode/areaName lolos; openAlerts() parse + buang invalid.
- `tests/panic-alert-screen.test.mjs`: lokasi dari unitCode/areaName; taken dengan nama.
- `e2e/legend-jztb7.mock.spec.ts` (pola `e2e/legend-1oi9.mock.spec.ts`, skenario lewat
  localStorage `legend.mock.panic`): alert muncul di `/fasilitas` (papan) dan tetap saat
  pindah ke `/fasilitas/kebersihan` (satu dialog); `taken-remote` -> "Rina sudah menuju lokasi";
  `restore` -> alert tampil setelah `page.reload()`; di 390 px tab Darurat terlihat penuh
  (boundingBox kanan <= lebar viewport dan tidak terpotong oleh scroll container).
