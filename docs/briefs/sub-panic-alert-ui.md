# Sub-brief: layar alert panik staf, Arah A (legend-alovk)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ui-panic-alert` (cabang `ui/panic-alert`). Jangan ubah server/API/shared kontrak (kecuali katalog teks i18n). Jangan commit.

Mockup disetujui (Arah A): `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/design-panic-alert/design/mockups/panic/` — `README.md`, gambar `<state>-desktop.png` / `<state>-mobile.png` untuk incoming, acknowledged, reconnecting, unreachable, revoked, multiple. Founder: lokasi paling besar; "Saya tangani" = staf menuju lokasi; alert beruntun diantre urut datang (FIFO); akses dicabut → arahkan ke perangkat lain yang aktif.

Klien WS (sudah ada, jangan ubah): `apps/web/src/features/facility-staff/panic-realtime.ts` (`createPanicRealtimeClient`, status `connecting|open|reconnecting|unreachable|revoked|stopped`, `onAlert(frame)`, `onRevoked`, `ack(alertId)` → POST `/api/emergency/alerts/:id/ack`). Frame: `{type:"panic", alertId, outletId, unitId: string|null, receivedAt, kind: "press"|"test"}` dari `@starter/shared/facility`. Ack: 200 ok (juga ulang oleh staf sama), 409 code `PANIC_ALREADY_ACKNOWLEDGED` = sudah ditangani rekan, 401 = sesi penerima hilang, 404.

## Berkas dan pemilik (tidak bertumpuk)

### A. `apps/web/src/features/facility-staff/panic-queue.ts` (pure, tanpa React)

```ts
export type PanicAckState =
  "idle" | "sending" | "mine" | "taken" | "failed" | "session";
export type PanicQueueItem = {
  alertId: string;
  outletId: string;
  unitId: string | null;
  receivedAt: string;
  kind: "press" | "test";
  order: number; // urutan datang, mulai 1
  ack: PanicAckState;
  dismissed: boolean;
};
export type PanicConnection =
  | "connecting"
  | "open"
  | "reconnecting"
  | "unreachable"
  | "revoked"
  | "stopped";
export type PanicQueueState = {
  items: PanicQueueItem[];
  connection: PanicConnection;
  nextOrder: number;
};
export type PanicQueueAction =
  | { type: "alert"; frame: PanicRealtimeFrame }
  | { type: "status"; status: PanicConnection }
  | {
      type:
        | "ack-start"
        | "ack-ok"
        | "ack-taken"
        | "ack-failed"
        | "ack-session"
        | "dismiss";
      alertId: string;
    };
export const initialPanicQueue: PanicQueueState; // connection "connecting"
export function panicQueueReducer(s, a): PanicQueueState;
export function pendingAlerts(s): PanicQueueItem[]; // ack idle|sending|failed|session, !dismissed, urut order
export function settledAlerts(s): PanicQueueItem[]; // ack mine|taken, !dismissed, urut order
export type PanicView =
  "idle" | "alert" | "queue" | "settled" | "unreachable" | "revoked";
export function panicView(s): PanicView;
```

Aturan: alertId ganda diabaikan (tidak menggeser urutan); FIFO = urutan datang, bukan receivedAt. `ack-start` hanya dari idle/failed/session; `ack-ok` → mine; `dismiss` hanya untuk mine/taken. `status` "revoked" bersifat lengket (status lain sesudahnya diabaikan). `panicView`: revoked → "revoked"; pending ≥2 → "queue"; pending 1 → "alert"; pending 0 dan connection unreachable → "unreachable"; settled ada → "settled"; selain itu "idle". (Reconnecting/unreachable dengan pending tetap menampilkan alert + banner koneksi.)

### B. `apps/web/src/features/facility-staff/use-panic-alerts.ts` + `panic-mock-socket.ts` (+ handler ack di `mock.ts`)

`usePanicAlerts(): { state: PanicQueueState; ack(alertId): Promise<void>; dismiss(alertId): void }`. `useReducer(panicQueueReducer)`; efek hanya di browser membuat klien sekali, `start()` saat mount, `stop()` saat unmount. URL: origin `VITE_API_URL` (lihat `lib/api/client.ts`), http→ws / https→wss, path `/api/emergency/ws`. socketFactory: `new WebSocket(url, protocols)`. `ack`: dispatch ack-start; `await client.ack`; ok → ack-ok; `ApiError` status 409 → ack-taken; 401 → ack-session; lain → ack-failed. Jangan pernah anggap sukses lokal bila API gagal.
Mode mock (cari cara deteksi mode mock di `apps/web/src/lib/mock/`): socketFactory memakai `createMockPanicSocket` dari `panic-mock-socket.ts` yang memutar skenario dari `localStorage["legend.mock.panic"]` (`incoming` bawaan, `multiple` 3 alert, `acknowledged` (ack → 409), `reconnecting`, `unreachable`, `revoked`, `idle`). Unit di frame mock memakai id unit dari data mock papan unit (`mock.ts`) supaya lokasi terbaca. Komponen tidak tahu datanya mock.

### C. `apps/web/src/features/facility-staff/components/panic-alert-layer.tsx` + katalog teks + pasang di `emergency-screen.tsx`

- `PanicAlertLayer({ facilityId })`: memakai `usePanicAlerts()` dan `useUnitBoard` (lokasi: unitId → `unit.code` + nama area via `areaName` di `view.ts`; tak ditemukan/null → "Lokasi belum diketahui"). Merender `PanicAlertScreen` (presentational, diekspor dari berkas yang sama, props: `state`, `resolveLocation(item)`, `onAck`, `onDismiss`, `pinHref`, `formatTime`) supaya bisa dites dengan `renderToStaticMarkup`.
- View alert/queue/settled/unreachable/revoked: native `<dialog>` layar penuh (`showModal()`, cegah `cancel` Esc saat alert pending). idle: tidak ada overlay; status koneksi kecil di halaman ("Terhubung ke outlet" / "Menyambung ulang…").
- Arah A: permukaan putih, garis merah atas, nama ruang paling besar (≥ 48px desktop, ≥ 40px mobile), ikon + teks "Darurat" (tidak bergantung warna), "UJI" untuk kind test, waktu diterima `tabular-nums`, tombol "Saya tangani" besar (≥ 56px tinggi, lebar penuh di mobile, terjangkau jempol). Queue: kartu bernomor 01/02/03 urut datang, tombol utama hanya di kartu pertama, lainnya outline "Saya tangani Ruang 12". Footer "Menangani satu alert tidak menyelesaikan alert lainnya."
- Ack sending: tombol disabled + "Mengirim…"; failed: pesan + "Coba lagi"; session: arahkan ke layar PIN; mine: "Anda menuju Ruang 07" (bukan "selesai") + tombol "Tutup"; taken: "Sudah ditangani rekan lain" (tanpa nama: kontrak belum memberi nama) + "Tutup".
- Reconnecting/unreachable dengan alert: banner di atas ("Koneksi terputus, mencoba menyambung. Alert di bawah mungkin bukan yang terbaru."). Unreachable tanpa alert: layar dengan tombol link ke PIN `/pos/ganti-pengguna`. Revoked: "Perangkat ini berhenti menerima alert darurat." + arahan pakai perangkat lain yang aktif; jangan karang penyebab.
- `aria-live="assertive"` untuk alert baru, fokus ke tombol utama saat alert datang, `motion-safe:` saja untuk gerak, tanpa kedip. Kontras tinggi, `prefers-contrast: more` aman.
- Teks: daftarkan di `packages/shared/src/i18n/messages/facility-staff.ts` di bawah `panic.*`, pakai `useT()`/`t()` seperti `emergency-screen.tsx`. Tidak ada teks hardcode.
- `emergency-screen.tsx`: pasang `<PanicAlertLayer facilityId={...} />`, ganti daftar sinyal mock seperlunya; jangan buang fitur angkat insiden.

### D. Test (test-writer) — `tests/panic-alert-queue.test.mjs` dan `tests/panic-alert-screen.test.mjs`

node:test, pola `tests/panic-realtime-client.test.mjs` (alias `tests/helpers/web-alias.mjs`) dan `tests/operations-checklist-labels.test.mjs` (`renderToStaticMarkup`). Wajib: antrean beruntun (FIFO, dedupe, alert ke-2 tidak mengganti yang dibaca), ack (sending→mine, 409→taken, gagal tetap pending + coba lagi, 401→session), revoked lengket dan layar revoked, unreachable tanpa alert → link PIN. Jalankan: `LEGEND_TEST_FILES="tests/panic-alert-queue.test.mjs tests/panic-alert-screen.test.mjs" heavy pnpm test` dari root worktree.
