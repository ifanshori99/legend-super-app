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

- [ ] 1 notes bead
- [ ] 2-3 klien + provider
- [ ] 4 env
- [ ] 5 stub + test
- [ ] 6 doc
- [ ] pra-gate, test terarah, typecheck, push
