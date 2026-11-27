# B5a (legend-wasr7.23) progres

Brief: `docs/briefs/1272-b5a-brief.md`. Cabang `ws/1272-b5a` dari `origin/int/rc2` (2ea44290a).

## Rencana

1. Notes bead: `bridge-provider.ts` `evidence()` parse lewat `ecrResultSchema`/`ecrInquiryResultSchema`; `CloudEdcRuntime.prepareSale(tenantId, outletId, terminals?)` hanya mengambil kunci outlet yang punya terminal `bca_cloud` aktif (opsi bayar memakai daftar terminal yang sudah dimuat, sale membaca satu baris). Test b2-15 disesuaikan (outlet D diberi terminal `bca_cloud`).
2. `bca-snap-client.ts`: token OAuth2 client_credentials (cache sampai kedaluwarsa - 60 s), header SNAP, tanda tangan asimetris (token) dan HMAC-SHA512 (transaksi) di satu modul, TODO `BCA-DOC`. Request ditulis di tick yang sama; tanpa token = tidak terkirim.
3. `bca-cloud-provider.ts`: sale `POST /openapi/v1.0/ecr/payment`, inquiry `POST /openapi/v1.0/ecr/inquiry-status`, void `transType` 08; cancel tidak didukung (selalu `EcrTransportError`). `partnerReferenceNo` = trace agent, nominal dari request. 202IS00/504IS00/409IS00 (alert)/5xx/timeout/jaringan/tak terbaca = `EcrTransportError` (unknown). 4xx yang jelas ditolak sebelum diproses (400/401/403/404/429) = `declined` dengan kode BCA (sale saja). `not_found` tanpa batch = agent tetap `unknown` + rekonsiliasi. `outlets()` lewat `app.active_tenant_registry` (tanpa migrasi).
4. Env `EDC_BCA_CLOUD_*` (semua atau tidak sama sekali, https di production, private key dibaca dan divalidasi); tanpa kredensial = provider tidak terpasang. `.env.example`, `deploy/single-vm/runtime.env.example`, `server.ts`.
5. Stub `src/test/helpers/bca-ecr-stub.ts`, test gagal-dulu `src/test/edc-bca-cloud.test.ts`.
6. Doc "Provider bca_cloud" di `docs/design/edc-bridge-protocol.md`.

## Status

- [x] 1 notes bead (commit 3e458c822)
- [x] 2-4 klien SNAP, provider, env (commit b00e69941)
- [x] 5 stub + test `src/test/edc-bca-cloud.test.ts` 17 test; gagal-dulu: tanpa fix bead notes 6 test gagal (b5a-3,4,5,6,13,14)
- [x] 6 doc "Provider bca_cloud" di `docs/design/edc-bridge-protocol.md`
- [x] pra-gate: prettier, eslint, typecheck api lulus; test terarah `edc-bca-cloud` + `edc-bridge-cloud` 36/36 lulus via `heavy`

## Keputusan penting

- 4xx sebelum diproses = `declined` (bukan `failed` "tidak pernah dikirim"): request sampai ke BCA, kode BCA disimpan sebagai bukti. Tidak membayar siapa pun.
- `ready` = token tersimpan; sale tanpa token = tidak dikirim. Token diambil di `prepareSale` dan di latar belakang saat `ready` false (maks sekali per 5 s sesudah gagal).
- Tanpa provider, terminal `bca_cloud` = `EDC_AGENT_NOT_READY` (bukan `EDC_PROVIDER_UNKNOWN`).
- `outlets()` lewat `app.active_tenant_registry`, tanpa migrasi.
- Sisa: semua titik `BCA-DOC` menunggu dokumen ECR BCA (B0); inquiry memakai `transType` kartu karena transType asli tidak ada di `EcrTraceRequest`.
