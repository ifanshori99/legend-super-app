# Brief legend-nvc7: koreksi absen ditolak tetap terlihat

Keputusan (review Opus C11): koreksi offline yang ditolak server (4xx final) TETAP di antrean, ditandai "Ditolak" + alasan server, tombol Coba lagi / Ubah / Buang. Bukan dihapus dengan toast. Tanpa migrasi, tanpa perubahan API.

Folder: `apps/web/src/features/ws10-hris-employee/` (disebut FE/). Antrean: `FE/queue.ts`, hook: `FE/hooks.ts`, kartu: `FE/components/pending-corrections.tsx`, dialog: `FE/components/correction-dialog.tsx`, banner: `FE/components/employee-home.tsx`. Katalog teks: `packages/shared/src/i18n/messages/id.ts` (blok `hris.correction`, `hris.home`). Test node: `tests/legend-nv3y.test.mjs`. E2E mock: `e2e/legend-nv3y.mock.spec.ts`.

## Kontrak (dibuat potongan A, dipakai potongan B dan test)

`queue.ts`:

```ts
export type CorrectionRefusal = {
  status: number;
  code: string;
  reason: string;
  at: string;
};
// QueuedCorrection mendapat field opsional: refused?: CorrectionRefusal  (isQueued memvalidasinya bila ada)
export function markCorrectionRefused(
  key,
  refusal: CorrectionRefusal,
  storage?,
): QueuedCorrection[];
export function isRefused(row: QueuedCorrection): boolean; // row.refused !== undefined
export function clearCorrectionRefusal(key, storage?): QueuedCorrection[]; // Coba lagi: hapus tanda
export function replaceQueuedCorrection(
  oldKey,
  body: CorrectionSubmission,
  employeeId,
  storage?,
  now?,
): QueuedCorrection[]; // Ubah: hapus lama, tambah baru (key baru dari body.idempotencyKey)
// Satu langkah putar-ulang, murni (submit disuntik), dipakai hook dan test:
export type ReplayOutcome = "sent" | "refused" | "retryLater";
export async function replayQueuedCorrection(
  row: QueuedCorrection,
  submit: (body: CorrectionSubmission) => Promise<unknown>,
  storage?,
  now?: Date,
): Promise<ReplayOutcome>;
//  sukses -> removeQueuedCorrection, "sent"
//  error retryable (isRetryableReplayError) -> entri tetap, tanpa tanda, "retryLater"
//  error 4xx final -> entri TETAP, markCorrectionRefused({status, code, reason: error.message, at}), "refused"
// Error bukan ApiError (status undefined) = retryable.
export function replayCorrectionQueue(
  rows,
  submit,
  storage?,
  now?,
): Promise<{ sent: number; refused: number }>;
//  lewati entri refused; berhenti di retryLater pertama (sama seperti loop lama); entri 4xx tidak memblokir sisanya.
```

`removeQueuedCorrection` (Buang) tetap seperti sekarang. `queuedFor` tetap.

`hooks.ts`:

- `useFlushCorrectionQueue` memakai `replayCorrectionQueue`; entri refused dilewati; toast `replayDropped` (teks diubah, lihat katalog) bila refused > 0; invalidate bila sent > 0.
- `useRetryCorrection()` -> mutation `(row: QueuedCorrection)`: `clearCorrectionRefusal` lalu `replayQueuedCorrection(row, submitAttendanceCorrection)`; hasil "sent" -> invalidate `hrisKeys.all`; "refused" -> entri kembali bertanda dengan alasan baru; "retryLater" -> entri jadi menunggu koneksi.
- `useDiscardCorrection()` -> fungsi/mutation memanggil `removeQueuedCorrection(row.key)`.
- `useQueuedCorrections()` tetap (mengembalikan semua entri milik karyawan, termasuk refused).

Katalog (id.ts, `hris.correction`): `refused: "Ditolak"`, `refusedReason: "Alasan server: {reason}"`, `refusedNoReason: "Server tidak memberi alasan."`, `retry: "Coba lagi"`, `edit: "Ubah"`, `discard: "Buang"`, `editTitle: "Ubah pengajuan koreksi"`, `editHint: "Perbaiki isian lalu kirim ulang. Pengajuan lama diganti."`. Ubah `replayDropped` jadi `"{count} pengajuan dari antrean ditolak server. Buka Beranda untuk coba lagi, ubah, atau buang."`. Pill menunggu koneksi memakai `hris.correction.queuedTitle` yang sudah ada.

## UI (potongan B)

- `PendingCorrections` menampilkan, di atas daftar dari server, entri antrean milik karyawan (`useQueuedCorrections`): refused = `StatusPill` tone danger "Ditolak", baris "Alasan server: ...", tiga tombol Coba lagi / Ubah / Buang (target sentuh >= 44 px di 390 px, tombol membungkus, tidak overflow); menunggu = pill info "Menunggu koneksi", tanpa tombol. Kartu tidak lagi menampilkan "Tidak ada pengajuan yang menunggu" bila ada entri antrean. Tombol punya nama aksesibel unik (aria-describedby ke baris entri).
- Coba lagi: `loading` selama kirim. Buang: hapus langsung (tindakan lokal, tidak ada data server yang hilang).
- Ubah: buka `CorrectionDialog` dengan prop baru `editing?: QueuedCorrection`: isian awal dari `editing.body` (jenis, waktu di zona outlet, alasan), judul `editTitle`; saat berhasil kirim/antre, entri lama dibuang (`replaceQueuedCorrection` atau remove). Kunci idempotensi baru (isi berubah = kunci baru, perilaku dialog yang ada).
- `employee-home.tsx`: hitungan banner "menunggu koneksi" hanya entri non-refused.
- Pakai komponen yang ada (`StatusPill`, `Button`), token warna, tanpa warna baru. Baca `~/.agents/team/ui-standard.md` bagian relevan.

## Test (potongan C)

Node (`tests/legend-nv3y.test.mjs`, jalan lewat `LEGEND_TEST_FILES=tests/legend-nv3y.test.mjs heavy pnpm test`): refused tetap di antrean dengan alasan, tidak diblokir urutan; retryLater (0/503/429) tidak menandai; coba lagi (clear + replay) sukses menghapus, gagal lagi memperbarui alasan; buang menghapus; replace mengganti; isQueued menolak refused rusak; HR-01 (employeeId lain tidak disentuh). Bukti gagal-dulu: tulis dulu, harus gagal karena fungsi belum ada.
E2E mock (`e2e/legend-nv3y.mock.spec.ts`): seed localStorage `legend-hris-corrections-queue` lewat `addInitScript` dengan satu entri refused milik CL-1003; Beranda menampilkan "Ditolak" + alasan; Coba lagi mengirim ulang (entri hilang, muncul di daftar server "Menunggu"); Buang menghapus; screenshot 390 dan 1280 ke `docs/design/screenshots/legend-nvc7/`. E2E TIDAK dijalankan oleh subagent; agent utama menjalankan lewat `heavy`.
