# Sub-brief: persetujuan kas keluar ditahan + jurnal (legend-3l4q, legend-ym2kr)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-651e6a75`, cabang `ws/cash-out-approval`.
Kartu: `bd show legend-3l4q`, `bd show legend-ym2kr`.

## Titik awal yang diketahui

- Emisi `cash_movement.recorded`: `apps/api/src/services/pos-shift.service.ts:645` (juga untuk yang ditahan).
- Jurnal null bila `needsApproval`: `apps/api/src/services/accounting-auto-journal-amounts.ts:1430`.
- Trigger `app.cash_movement_outcomes_guard` (`apps/api/src/db/.../pos-shift.custom.sql:236`) menolak outcome `approved`.
- Tabel `cash_movement_outcomes` (migrasi 0143), `expireHeldCashMovements`, `computeShiftAggregates`, `difference_idr`.

## Aturan uang

- Kas keluar disetujui terhitung tepat sekali di `expected`/`difference` laci; ditahan/ditolak/kedaluwarsa = tidak terhitung.
- Jurnal terbentuk tepat sekali saat approve (kunci `aj:cash-movement:<id>`, idempoten pada replay); ditolak = tanpa jurnal.
- Shift yang sudah ditutup tidak boleh berubah angkanya (approve setelah tutup ditolak).
- Migrasi: satu berkas, nomor 0385.

## Fakta (Explore)

- Tabel outcomes: `apps/api/drizzle/0149_cash_movement_outcomes.sql` (trigger di :80-126), sumber custom `apps/api/src/db/schema/pos-shift.custom.sql` ~215. Trigger menolak 'approved' mentah-mentah, wajib needs_approval=true, outcome non-'expired' butuh shift `open` (FOR SHARE). UNIQUE (tenant_id, movement_id).
- `needsApproval` diset `pos-shift.service.ts:609-624` (amount > expected). Baris movement immutable (trigger blok UPDATE).
- `computeShiftAggregates` (`pos-shift-support.ts:~359`) filter `needsApproval = false`. `heldCashOutIdrOf` (:~393) jumlahkan semua `needsApproval = true`. Count menyimpan heldCashOutIdr; close menolak count basi bila held berubah. `expireHeldCashMovements` (:~493) tulis 'expired' untuk held tanpa outcome, dipanggil `pos-shift.service.ts:~1405`.
- Day report `pos-day.service.ts:~636-668` jumlahkan outcome 'expired'.
- Jurnal: `cashMovementFactOf` (`accounting-auto-journal-amounts.ts:1393`) baca ulang baris DB; :1430 `if (movement.type === "drop" || movement.needsApproval) return null;`. Kunci `aj:cash-movement:${movementId}` (:731), dijaga consumer `accounting-auto-journal-consumer.ts:396-413` + unique `journal_entries_tenant_idempotency_key`. Test: `apps/api/src/test/accounting-auto-journal-cash-movement.test.ts` (AJ-CM-*).
- Belum ada izin penyetuju kas keluar ditahan. Sementara pakai `shift.cash.approve_close` lewat SATU konstanta (lihat B), route TIDAK dipasang sampai CTO memutuskan.

## Desain

Definisi:

- "Ditahan" (held) = `needs_approval = true` DAN belum punya outcome apa pun.
- "Disetujui" = punya outcome 'approved'. Terhitung di drawer seperti kas keluar/setoran biasa.
- "Ditolak"/"kedaluwarsa" = tidak terhitung; kas tetap di laci; tanpa jurnal.
- Shift tertutup: hanya punya outcome 'expired' (approved/rejected hanya saat open), jadi angka shift lama tidak berubah. Jangan ubah perlakuan 'expired'.

### A. Migrasi + angka laci (implementer A)

File: `apps/api/drizzle/0385_cash_movement_approval.sql` (+ `drizzle/meta` bila perlu, ikuti pola custom migration proyek), `apps/api/src/db/schema/pos-shift.custom.sql`, komentar di `apps/api/src/db/schema/pos-shift.ts`, `apps/api/src/services/pos-shift-support.ts`, `apps/api/src/services/pos-day.service.ts` (bila perlu).

1. `CREATE OR REPLACE FUNCTION app.cash_movement_outcomes_guard`: cabut penolakan 'approved'; aturan lain tetap (needs_approval, shift/outlet cocok, non-expired butuh shift open FOR SHARE, tanpa UPDATE/DELETE). Tambah: outcome 'approved'/'rejected' wajib `decided_by <> movement.recorded_by`.
2. `computeShiftAggregates`: cash movement terhitung bila `needs_approval = false` ATAU ada outcome 'approved' (EXISTS / left join, tidak dobel).
3. `heldCashOutIdrOf`: hanya held tanpa outcome 'approved'/'rejected' (outcome 'expired' tetap dihitung seperti sekarang supaya shift tertutup tidak berubah).
4. Grep SEMUA pemakai `cashMovements.needsApproval` / `needs_approval` di `apps/api/src` (bukan test) dan sesuaikan yang menghitung angka laci/laporan (day report, close summary, listCashMovements DTO bila ada status). Laporkan daftarnya.
5. Pastikan `pnpm db:generate` tetap kosong (fungsi trigger bukan bagian schema drizzle).

### B. Service setuju/tolak (implementer B)

File baru `apps/api/src/services/pos-shift-cash-approval.service.ts`, plus registrasi event di tempat tipe event shift didaftarkan (cari `"cash_movement.recorded"` di `apps/api/src` dan `packages/shared/src`, juga katalog root `tests/*contract*.mjs`), label audit baru bila ada katalog.

```ts
export const HELD_CASH_MOVEMENT_APPROVE_PERMISSION = "shift.cash.approve_close"; // sementara, menunggu CTO
export async function decideHeldCashMovement(
  context: ScopedTenantContext,
  caller: ShiftCaller,
  outletId: OutletId,
  movementId: string,
  input: { decision: "approved" | "rejected" },
): Promise<{
  movementId: string;
  outcome: "approved" | "rejected";
  decidedBy: string;
  decidedAt: string;
}>;
```

Dalam satu `withTenant` tx: `assertOutletPermission(... HELD_CASH_MOVEMENT_APPROVE_PERMISSION)`; kunci shift `FOR UPDATE` (pakai `findShift(..., true)` pola recordCashMovement); shift harus open (`CONFLICT` bila tidak); movement harus outlet sama, `needs_approval`, belum ada outcome. Replay: outcome sama sudah ada oleh pemutus sama → kembalikan yang ada tanpa efek baru; outcome lain → `CONFLICT`. Penyetuju ≠ `recorded_by` (`FORBIDDEN`). Approve: hitung expected sekarang (pola :609-624) dan tolak `CONFLICT` bila `amountIdr > expected` (outlet tidak rugi: tidak membayar kas yang tidak ada di laci). Insert outcome; approve → `appendShiftEvent(tx, context, "cash_movement.approved", { aggregateId: movementId, outletId, payload: { movementId, shiftId, outletId, deviceId, type, amountIdr, recordedAt, approvedBy, approvedAt }, caller, now })`; audit `pos_shift.cash_movement_approved` / `pos_shift.cash_movement_rejected`. Export juga dari tempat yang sesuai; JANGAN pasang route.

### C. Auto-journal (implementer C)

File: `apps/api/src/services/accounting-auto-journal-amounts.ts`, `accounting-auto-journal-consumer.ts`, aturan posting/registry event bila ada (cari pendaftaran `cash_movement.recorded`).

- Consumer menerima event baru `cash_movement.approved` (skema zod di samping `cashMovementRecordedSchema`), memakai fact builder yang sama dan kunci yang SAMA `aj:cash-movement:<movementId>`.
- `cashMovementFactOf`: bila `needsApproval` → cari outcome; 'approved' → fact seperti biasa dengan `moneyTime = decidedAt`; selain itu → null. Drop tetap null.
- Replay `cash_movement.recorded` lama setelah approve tidak boleh membuat jurnal kedua (kunci sama → `already_posted`). Ditolak/kedaluwarsa → `ignored`.

### Test (test-writer, gagal-dulu)

File baru `apps/api/src/test/pos-shift-cash-approval.test.ts` dan tambahan kasus di `apps/api/src/test/accounting-auto-journal-cash-movement.test.ts`. Ikuti setup di `pos-shift-held-expire.test.ts` dan AJ-CM-*. Kasus:

1. Approve held cash out: expected turun tepat amount sekali; held turun amount; difference close benar; outcome 'approved'.
2. Replay approve: tanpa efek kedua (expected sama, satu outcome, satu event).
3. Reject: expected & held tanpa kas keluar itu; tanpa event approved; tanpa jurnal.
4. Approve oleh pencatat sendiri → FORBIDDEN; tanpa izin → FORBIDDEN.
5. Approve saat amount > expected sekarang → CONFLICT, tanpa efek.
6. Approve setelah shift tutup → CONFLICT; angka shift tertutup (report) tidak berubah; trigger DB juga menolak insert langsung 'approved' bila shift tutup.
7. Jurnal: approve → tepat satu jurnal kunci `aj:cash-movement:<id>` (kredit kas, debit lawan), moneyTime = decidedAt; replay event approved dan replay event recorded → tetap satu. Held tanpa keputusan → nol jurnal. Drop disetujui → efek laci, nol jurnal.
   Gagal-dulu harus karena sebab benar (fungsi tidak ada / trigger menolak), bukan setup.

## Putaran 2 (keputusan CTO 15 Nov)
Penyetuju = `shift.cash.approve_close` (opsi A). UI di kelola web saja. Perbaiki celah recordCashMovement.

### Kontrak route (tetap; R, W, test-writer memakai ini)
- `POST /api/outlets/:outletId/pos/shifts/:shiftId/cash-movements/:movementId/decision`, body strict `{ decision: "approved" | "rejected" }` → 200 `{ data: { movementId, outcome, decidedBy, decidedAt } }`.
- Shared: endpoint object `decidePosCashMovement` (params outletId, shiftId, movementId; body schema; response) di file yang sama dengan `recordPosCashMovement`; tipe `PosCashMovementDecision`.
- Route di `apps/api/src/routes/pos-shift.routes.ts` setelah GET cash-movements: guard `can(HELD_CASH_MOVEMENT_APPROVE_PERMISSION)` (pola `operate`), `jsonBody`; router sudah di bawah requireAuth + requireTrustedOrigin (pastikan).
- Service `decideHeldCashMovement` dapat parameter `shiftId` (setelah outletId); movement dengan shift lain → NOT_FOUND.
- Galat: FORBIDDEN 403 (tanpa izin / pencatat sendiri), CONFLICT 409 (sudah diputuskan lain, shift tutup, melebihi kas laci — pesan beda), NOT_FOUND 404.

### R: route + shared (implementer, worktree terpisah)
File: shared endpoint/types (cari `recordPosCashMovement` di packages/shared/src), `pos-shift.routes.ts`, `pos-shift-cash-approval.service.ts` (param shiftId). Commit di worktree-mu.

### W: UI kelola (implementer, worktree terpisah)
Daftar kas keluar tertahan yang sudah ada (cari pemakai `shift-extra-api.ts` / teks `pos-kasir-supervisor.ts` "Perlu persetujuan"; layar supervisor/kelola, bukan perangkat kasir). Tambah per baris tombol Setujui/Tolak + dialog konfirmasi (shadcn), mutation hook `useDecideHeldCashMovement` (api.ts → hooks.ts, invalidasi query daftar & shift), galat CONFLICT/FORBIDDEN/limit laci jelas. Semua teks di katalog `packages/shared/src/i18n/messages/pos-kasir-supervisor.ts`. Tombol hanya tampil bila pengguna memegang `shift.cash.approve_close` (presentasi saja). Ikuti `~/.agents/team/ui-standard.md`. Mock (`mock-engine.ts`) ikut mendukung decision bila layar memakai mock. Commit di worktree-mu.

### F: celah recordCashMovement (setelah fail-first)
`pos-shift.service.ts:~609-624`: `needsApproval = amountIdr > expected - heldCorrectionCashIdrOf(tx, shift)`.

### Test (test-writer)
1. `apps/api/src/test/pos-shift-cash-approval.test.ts`: recordCashMovement dengan refund/void tertahan → kas keluar yang muat di expected tapi melebihi expected − koreksi tertahan HARUS ditahan (needsApproval true, tidak masuk expected). Kas keluar yang muat setelah dikurangi → tidak ditahan.
2. File baru `apps/api/src/test/pos-shift-cash-approval-route.test.ts`: HTTP route di atas: 200 approve oleh supervisor; 403 kasir (tanpa izin); 403 pencatat; 409 kedua kali beda keputusan; 404 movement shift lain/outlet lain/tenant lain; 400/422 body tidak valid; origin tidak tepercaya ditolak.

### Putaran 2 — perbaikan UI (dari ui-auditor + architect)
File: `apps/web/src/features/ws04-pos-kasir/components/supervisor/held-cash-out-gate.tsx`, `hooks.ts`, `shift-extra-api.ts`, `shift-extra-types.ts`, `mock-engine.ts`, katalog `packages/shared/src/i18n/messages/pos-kasir-supervisor.ts`.
1. Fokus setelah keputusan: pindah ke notice sukses (`tabIndex={-1}`, fokus) — jangan jatuh ke body.
2. Live region `role="status"` selalu ter-mount; teks sukses memuat `{type}` dan `{amount}`; scroll/fokus ke sana; kosongkan saat `onContinue`.
3. Tombol Setujui/Tolak: `aria-describedby` ke judul+meta baris (alasan, waktu, kasir).
4. Pencatat sendiri: bandingkan `recordedBy` movement dengan user sesi; tombol nonaktif + alasan terlihat (teks katalog "Dicatat oleh Anda; supervisor lain yang memutuskan."). Bila `recordedBy` belum ada di tipe web, tambahkan dari DTO.
5. Judul dialog & teks sukses pakai `{type}` (Kas keluar / Setoran kas), bukan "kas keluar" tetap.
6. Galat tak bisa diulang (403/404/409): tombol "Tutup" (key baru), bukan "Batal".
7. `onSettled` jangan `await` invalidasi; dialog tertutup begitu mutation sukses. Refetch gagal tidak boleh menghapus notice.
8. Render `DecideDialog` sekali di luar cabang list/empty.
9. Tombol baris varian outline/secondary (satu aksi utama per layar).
10. Notice sukses juga menyebut: kasir perlu menghitung ulang laci sebelum tutup shift bila sudah menghitung (key katalog baru).
11. `shift-extra-api.ts`: pakai endpoint shared `decidePosCashMovement` (callEndpoint/pola yang dipakai file itu) dan tipe `PosCashMovementDecision`; hapus tipe lokal `HeldCashDecisionResult`.
12. Mock: keputusan sama oleh pemutus sama = 200 idempoten (sama dengan API).
