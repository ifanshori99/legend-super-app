# Brief subagent: legend-jmsdx pepper PIN per outlet (v2+), rehash cloud, runbook

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/jmsdx-pepper` (cabang `ws/jmsdx-pepper`, basis `ws/ideif-edge-pepper` + merge `ws/u7g9w-pin-proof`).
Keputusan: `bd show legend-jmsdx` dan `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/6a8e6daa-2971-43d1-b254-b9a971dcda14/scratchpad/DECISIONS.md` baris 139-233. Baca keduanya dulu. Tanpa migrasi.

Aturan umum: hanya file di potonganmu. Jangan jalankan test/typecheck/build. Jangan commit. Edit pakai Edit/Write. Kode/komentar bahasa Inggris; pesan error user bahasa Indonesia. Laporan akhir: file berubah, ekspor baru/berubah, keputusan kecil, hal yang belum yakin. Jangan ubah `services/staff-pin-proof.service.ts` (kartu u7g9w).

## Kontrak bersama

`apps/api/src/services/device-pin-pepper.ts` (potongan P):

```ts
/** Version >= 2: HKDF info `legend:staff-pin-pepper:v{n}:{tenant}:{outlet}` (lowercase ids). Version 1: per tenant (old info), cloud only. */
export function staffPinPepper(
  tenantId: string,
  outletId: string,
  version?: number,
): Buffer; // throws RangeError if unusable
export function staffPinPepperOrNull(
  tenantId: string,
  outletId: string,
  version: number,
): Buffer | null;
/** Cloud only. Versions to send = ({pepper_version used by staff_pins rows of that outlet, >= 2} ∪ {current}) \ have \ {1}. */
export function staffPinPeppersForEdge(
  tenantId: string,
  outletId: string,
  have: readonly number[],
  usedVersions: readonly number[],
): Array<{ version: number; pepper: string }>;
```

Edge: `staffPinPepper` on edge reads the edge registry by version and returns null/throws for version 1 or any outlet other than the node's own outlet. `env.ts` default `STAFF_PIN_PEPPER_CURRENT_VERSION = 2` (min tetap 1 di schema env, tetapi cloud boleh 1 untuk dev lama).

Kode error baru: `STAFF_PIN_RESET_REQUIRED` 409 ("PIN perlu diatur ulang."), didaftarkan di `packages/shared/src/identity/errors.ts` (potongan D).

## Potongan P: turunan, sync, registry edge (implementer)

File: `apps/api/src/services/device-pin-pepper.ts`, `apps/api/src/config/env.ts` (default saja), `apps/api/src/services/staff-pin-sync.ts` (query `peppers` jadi daftar versi `2,3`; string kosong = tidak memegang apa pun; tanpa param = tidak minta pepper; kirim `staffPinPeppersForEdge` untuk outlet node itu saja, `usedVersions` dari `SELECT DISTINCT pepper_version FROM staff_pins WHERE tenant, outlet`), `apps/api/src/edge/staff-pin-pepper-registry.ts` (ganti `edgeStaffPinPepperContiguous` dengan `edgeStaffPinPepperVersionsHeld(): number[]`), `apps/api/src/edge/staff-pin-pepper-store.ts` (AAD `tenant:outlet:version`), fetcher edge yang membangun query `peppers` (grep `peppers=` di `apps/api/src/edge`), shared contract query bila ada di `packages/shared`. Semua pemanggil `staffPinPepper*` di luar `device-pin.service.ts` disesuaikan ke signature baru (grep). Test lama di file pepper (`edge-pepper-registry.test.ts`, `edge-pepper-store.test.ts`, `edge-staff-pin-fetcher-pepper.test.ts`, `edge-staff-pin-pull-pepper.test.ts`, `staff-pin-sync-pepper.test.ts`, `config/env.test.ts`) diperbarui ke protokol baru.

## Potongan D: verify cloud rehash, edge 409 (implementer)

File: `apps/api/src/services/device-pin.service.ts`, `apps/api/src/services/device-pin-hash.ts` bila perlu, `packages/shared/src/identity/errors.ts`, seed dev/test (grep `pepperVersion`/`STAFF_PIN_PEPPER_VERSION` di `apps/api/src/db/seed*` dan helper test; test lama yang mengimpor `STAFF_PIN_PEPPER_VERSION` disesuaikan bila maknanya "versi current").

- Semua `staffPinPepper*` di file ini memakai outlet baris (`bindingOf`).
- `setStaffPin` (cloud dan edge): versi current, pepper outlet itu.
- `attemptStaffPin` cloud: PIN benar dan `row.pepperVersion < current` -> rehash di tx `FOR UPDATE` yang sama: salt baru, hash baru dengan pepper outlet versi current, `pepperVersion = current`, `updatedAt = now`. `pinGenerationAt`, `pinSetAt`, `generationEdge*`, `cloudGenerationAt` TIDAK diubah. Pastikan perubahan bahan hash dikirim ulang ke edge (cek bagaimana export memilih baris yang berubah, mis. `updatedAt`; edge menerapkan karena kunci sama, aturan `record key >= local key`).
- Edge: baris `pepperVersion === 1` -> hasil baru `{kind: "reset_required"}` -> `IdentityError`/`HttpError` 409 `STAFF_PIN_RESET_REQUIRED`, tanpa menaikkan `failedAttempts`, tanpa lock. Edge tidak pernah rehash.
- Versi lama (>=2, < current) tetap terverifikasi tanpa batas waktu di cloud dan edge.
- Jangan ubah perilaku lockout lain.

## Potongan R: runbook (doc-writer)

File baru `docs/runbooks/edge-node-stolen.md` (bahasa Indonesia sederhana, untuk operator): kapan dipakai; langkah berurutan: cabut node edge dan semua token device outlet itu (sebut endpoint/perintah nyata bila ada, grep `revoke` di `apps/api/src/routes` untuk edge node dan device), naikkan `STAFF_PIN_PEPPER_CURRENT_VERSION` di env cloud lalu deploy, reset PIN semua staf outlet itu DAN baris staf yang sama di outlet lain, cek outlet lain tidak terdampak (verify PIN staf outlet lain tetap jalan, edge outlet lain tidak dicabut); yang TIDAK perlu (rotasi pepper outlet lain); risiko tersisa (tebak offline PIN 6 digit untuk staf outlet itu, root bocor = kejadian lain). Rujuk keputusan di `docs/DECISIONS.md` 2026-11-10 "Pepper PIN per outlet".

## Potongan T: test penerimaan (test-writer)

File baru: `apps/api/src/test/staff-pin-pepper-outlet.test.ts`. Satu `it` per kriteria (a)-(h), nama diawali ID: (a) pepper outlet A != B (tenant, versi sama); (b) edge outlet A tanpa root memverifikasi PIN staf outlet A, pepper miliknya gagal memverifikasi hash outlet B; (c) sync tidak pernah mengirim versi 1 atau pepper outlet lain; (d) verify cloud baris versi 1 -> baris jadi versi 2, PIN tetap benar; (e) edge baris versi 1 -> 409 STAFF_PIN_RESET_REQUIRED, failed_attempts tetap; (f) rehash cloud tidak mengubah pin_generation_at, dan PIN lebih baru yang di-set di edge tidak tertimpa rehash (terapkan record cloud hasil rehash ke edge yang punya kunci lebih besar -> edge tetap PIN baru); (g) edge memegang {2,3}, current 3 -> hanya menerima versi yang belum dipegang (kosong bila semua dipegang; {4} bila current 4); (h) PIN di-set di edge terverifikasi di cloud. Pola: lihat test pepper yang ada (`edge-pepper-registry.test.ts`, `staff-pin-sync-pepper.test.ts`, `edge-staff-pin-resend.test.ts`, `device-pin-service.test.ts`). Test harus gagal di basis dan lulus setelah implementasi.
