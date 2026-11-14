# Brief bersama: flake test suite penuh (ws/suite-flakes)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-ff7fe627` (basis `milestone/m1` b17554cb9).

## Aturan semua subagent

- Hanya ubah berkas test atau helper test di `apps/api/src/test/` yang disebut di kartumu. Jangan sentuh kode produksi, migrasi, atau berkas test lain.
- JANGAN jalankan tsc, vitest, atau `pnpm test` (satu token heavy per thread: hanya test-runner). Baca, edit, lalu lapor.
- Jangan commit, jangan push.
- Logika uang (payroll, pembayaran) tidak diubah: hanya setup, jam, tenant, kode unik test.
- Arah perbaikan: tunggu kondisi dengan `vi.waitFor(..., { timeout: 5000-10000 })` bukan default 1 s; waktu dari satu sumber (jam DB atau jam test, jangan campur); tenant/kode/ID unik per suite; hindari hitungan global atau halaman yang dipakai berkas lain; cleanup berbasis ID milik sendiri, bukan `LIKE` atau `created_at`.
- Tipe brand (`TenantId`, `OutletId`): pakai helper bertipe proyek, bukan `as`.
- Jangan melemahkan assertion: perbaiki penyebab, bukan longgarkan hasil yang diverifikasi.
- Laporan: 3-6 baris. Akar masalah, perubahan (berkas:baris), apa yang tidak bisa dibuktikan tanpa menjalankan test.

## Kartu dan berkas

| Kartu        | Berkas                                                                                       | Dugaan                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| legend-gnm6y | `edge-catalog-loop.test.ts`, `edge-catalog-sync.test.ts`                                     | waitFor 1 s; loop network-error ~:354 tanpa barrier putaran penuh seperti kasus HTTP500 di sebelahnya; sync membaca halaman 100 record bersama berkas lain |
| legend-9uks  | `edge-registry-pull.test.ts` (~:467)                                                         | `vi.waitFor` default 1 s di 'corrupt stored watermark'                                                                                                     |
| legend-whg2  | `core-outbox-consumer.test.ts` (~:230)                                                       | relayOutbox setelah replayOutbox dapat 0; urutan/waktu, outbox bersama                                                                                     |
| legend-0lyzf | `member-signin.test.ts` (hanya 'AUTH-01 banned user'; menu-print-db sudah beres `399e99b0b`) | webhook jawab error body; withInboundSlot / limiter AUTH-04 bersama antar berkas; cetak body respons bila `completed` hilang                               |
| legend-y9uop | `payroll-thr-gross-up.test.ts`, `payroll-pph21-december-runs.test.ts`                        | tabel statutory tenant sama; cleanup `code LIKE 'SM\_%'`; PAYROLL_RUN_EMPTY dan PAYROLL_SNAPSHOT_MISMATCH palsu. Isolasi: tenant atau kode unik per berkas |
| legend-u7ozi | `metrics-daily-job.test.ts`                                                                  | 'runs once per interval per tenant unless forced' timeout 20 s di run penuh; cari hitungan global/tenant bersama atau waktu                                |
| legend-60psh | `payment-admin-api.test.ts`                                                                  | `valid_from` -1 minute -> -1 hour (jam DB vs API)                                                                                                          |

Berkas yang dihindari (batch62): `data-import-registry`, `edge-order-*`, `edge-link-*`, `payroll-payout-*`, `operations-checklist*`, `accounting-finance-exceptions`.
