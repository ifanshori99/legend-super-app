# 918 payout: 3 P2 second opinion 917 + l2zru
Cabang ghostex/918-payout-3-p2-l2zru-bekukan-batch di atas cbc98a31f. Migrasi sementara mulai 0660. Tidak merge, tidak deploy. Temuan: `git show origin/qa/second-opinion-payout-911-915:docs/qa/second-opinion-payout-911-915.md`.
Aturan uang: tidak ada pihak dibayar lebih, outlet tidak rugi; ragu -> aturan yang membatasi pembayaran.

## legend-87dur (recon binding_duplicate setelah withdraw + ajukan ulang)
- `apps/api/src/services/payroll-payout-recon.service.ts` ~962-984: helper `replaced(b)` mensyaratkan tak ada attestation di bukti b (:964). Binding K1 yang ditarik punya attestation propose + step `withdraw` (0658 :845 correction, :947 overpaid) sehingga selalu dianggap duplikat.
- Fix: binding dikecualikan bila bukti itu punya attestation `withdraw` dan TIDAK punya attestation langkah selesai (bukan propose, bukan withdraw). Histori + larangan pakai ulang bukti tetap. Kontrol `[911-recon-replacement-control-duplicate]` (payroll-payout-911-recon-replacement.test.ts:536) tetap harus flag dua operasi selesai.
- Test: perluas `[915-withdraw-correction-repropose-new-proof]` (payroll-payout-915-withdraw.test.ts ~1014) dan padanan overpaid (~1043) dengan recon setelah K2 selesai: nol flag/exception, binding+log K1 tersimpan, jurnal tepat satu.

## legend-fwx7l (migrator tetap ADMIN atas role grantor)
- `apps/api/src/db/migrator-role.ts` ~137-211: `provisionMigrator` opsi tanpa `grantorUrl`; `grantAdminOnExistingRoles` (~88-109, melewati role tak ada / ADMIN sudah ada) hanya `legend_app`, `legend_payout`, restricted.
- Fix: tambah `grantorUrl?`, parse dengan `GRANTOR_LOGIN` (db/provision-roles.ts:32, cek siklus impor), tambah login + `legend_payout_grantor` ke daftar ADMIN (INHERIT FALSE, SET FALSE seperti lain); `apps/api/src/provision-roles.ts` ~101-111 teruskan `PAYOUT_GRANTOR_DATABASE_URL`.
- Test: `tests/db-role-provisioning.test.mjs` ~1324 hapus GRANT manual fixture; grup+login grantor dibuat bootstrap, database milik migrator baru, `provisionMigrator` nyata, migrasi, `provisionRoles({grantorUrl})` sebagai non-superuser harus lulus; kontrol penolakan role berbahaya tetap.

## legend-9n1mu (api tak boleh lolos kewajiban grantor lewat WORKER_DATABASE_URL)
- `apps/api/src/config/env.ts:101` field opsional, :821-838 refine production lolos bila `EDGE_MODE || Boolean(WORKER_DATABASE_URL) || PAYOUT_GRANTOR_DATABASE_URL`. `env.ts:855` parse saat impor. `worker-main.ts:156` impor env; `server.ts:6` impor env.
- Fix: hapus term WORKER_DATABASE_URL dari refine; entrypoint worker menandai diri lewat kode (modul side-effect impor pertama, mis. `src/role-worker.ts` set `globalThis.__LEGEND_PROCESS_ROLE="worker"`, dibaca di refine). Edge: pengecualian EDGE_MODE hanya bila terbukti (api tidak boleh lolos hanya dengan env; pertimbangkan tandai edge entrypoint juga bila ada, jika tidak ada entrypoint terpisah, edge tetap lewat EDGE_MODE seperti sekarang dan catat).
- Test: `apps/api/src/test/env.test.ts` 35-98 (child process): api production grantor kosong + WORKER_DATABASE_URL terisi -> keluar sebelum listen; api dengan grantor hidup; entrypoint worker tanpa grantor tetap start.

## legend-l2zru
Lihat docs/briefs/918/design-l2zru.md (dibuat setelah peta).
