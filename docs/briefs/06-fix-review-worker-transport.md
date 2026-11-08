# Temuan review legend-18qw (untuk engineer, ws/worker-transport)

## Second-opinion (Codex, commit b22d549)
1. Major — `apps/api/src/worker/notification-adapters.ts:636`: `X-Legend-Reference` tidak mengaktifkan deduplikasi Brevo. Email diterima lalu respons hilang -> retry mengirim email kedua (probe mereproduksi). Fix: UUID stabil di `headers.idempotencyKey` (lihat https://developers.brevo.com/docs/heterogenous-versions-batch-emails), respons duplikat dianggap ack, tentukan recovery setelah TTL. Bisa menutup `legend-3a0y`.
2. Major — `apps/api/src/worker/notification-adapters.ts:461`: supervisor banned membuat daftar supervisor nonkosong sehingga fallback owner dilewati; setelah filter banned, penerima kosong padahal owner aktif ada. Fix: filter akun aktif sebelum menentukan fallback. Tambah test.

## Reviewer (Claude)
(menyusul)
