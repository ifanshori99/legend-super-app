# 1170 / legend-h2wvx: file API yang bertabrakan di run 2 worker

Run penuh API dengan 2 worker (lewat `heavy`, 19 Nov) MERAH: sekitar 16k test lulus, 11 gagal di 7 file. Sesuai brief 1170, batas 1 worker di `apps/api/vitest.config.ts` (`fileParallelism: false`, `VITEST_MAX_WORKERS=1`) dikembalikan. Kartu `legend-h2wvx` tetap open.

Log run: `/private/tmp/1170-api-full-two-workers.log` (sementara). Sebab di bawah adalah DUGAAN dari pembacaan kode dan pesan galat; belum diverifikasi dengan run terarah.

## Kelompok A: payout, sidik jari bukti dan rekonsiliasi (5 file, 7 test)

| File (`apps/api/src/test/`) | Test | Galat |
|---|---|---|
| `payroll-payout-891-correction.test.ts` | `[891-concurrent-first-steps]` | `PAYOUT_PROOF_FINGERPRINT_PENDING` |
| `payroll-payout-897-proof-binding.test.ts` | `[897-cross-tenant-correction]` | `PAYOUT_PROOF_FINGERPRINT_PENDING` |
| `payroll-payout-990-recon-reopen.test.ts` | `[legend-hklnq-reraise-failure-page-ok]` | `PAYOUT_GUARD_REFUSED` (diharapkan 200/201) |
| `payroll-payout-89xse-storage-timeout.test.ts` | `[89xse-fast-missing-still-missing]` | 404 `PAYOUT_RECON_FLAG_NOT_FOUND` (diharapkan 201) |
| idem | `[89xse-breaker-one-timeout-per-page]` | 404 `PAYOUT_RECON_CLEARANCE_NOT_FOUND` |
| `payroll-payout-888-overpaid-route.test.ts` | `[overpaid-route-concurrent]` | diharapkan 1, dapat 0 |
| idem | `[overpaid-route-concurrent-first-steps]` | diharapkan 1, dapat 0 |

Dugaan sebab: pekerja sidik jari bukti (latar global) dan tabel flag/clearance/sighting rekonsiliasi dipakai lintas file. `FINGERPRINT_PENDING` muncul saat pekerja milik file lain belum menyelesaikan baris yang dimiliki file ini; 404 dan hitungan 0 cocok dengan sapuan atau pembersihan file lain yang menghapus baris. Perlu: cakup sapuan dan pekerja per tenant atau per fixture, atau tandai file-file ini serial.

## Kelompok B: kuota paket (1 file, 2 test)

| File | Test | Galat |
|---|---|---|
| `hris-leave-release-event-db.test.ts` | "filing with no leave approval policy is refused (409)" | "Kuota paket sudah tercapai." |
| idem | "rejected and cancelled requests emit none" | idem |

Dugaan sebab: penghitung batas paket dibaca dari sumber bersama (jumlah baris lintas tenant atau tenant/paket yang dipakai bersama file lain), sehingga file lain yang berjalan bersamaan membuat batas tercapai. File juga menghapus `approval_policies` dengan `action_type = 'leave'`. Sumber kuota belum dipastikan.

## Kelompok C: kebijakan payroll (1 file, 2 test)

| File | Test | Galat |
|---|---|---|
| `payroll-policy-api.test.ts` | "pages by name with a cursor" | 422 (diharapkan 200) |
| idem | "tenant B creates its own policy" | `Cannot read properties of undefined (reading 'map')` |

Dugaan sebab: membaca `legal_entities ... LIMIT 1` tanpa batas tenant (sekitar baris 206), jadi mengambil entitas hukum file lain; 422 dan `.map` undefined adalah akibat turunan. Bisa juga terkait kuota paket (kelompok B). Isolasi tenant dan pagination harus dibuktikan terpisah.

## Langkah berikut

Satu bead per kelompok (lihat bead lanjutan di `bd`). Cabut batas 1 worker hanya setelah ketiganya beres DAN satu run penuh 2 worker hijau.
