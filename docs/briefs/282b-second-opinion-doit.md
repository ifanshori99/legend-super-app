# Brief 282b: second opinion untuk DOIT getPayment (legend-6g29)

## Peran

Baca `~/.agents/team/roles/second-opinion.md` dan `~/.agents/team/TEAM.md`.

- Agent Codex, model `gpt-6.1-sol`, effort xhigh (tingkat K: uang).
- Read-only: jangan ubah kode, jangan commit, jangan push, jangan merge.
- Jangan baca `.env*` atau isi rahasia apa pun.
- Langkah pertama: pecah tugas, lalu spawn subagent paralel dalam satu giliran (jika dibutuhkan).

## Repo

- Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-get-payment`, cabang `ws/doit-get-payment`.
- Diff review: `git diff milestone/m1...ws/doit-get-payment`. Diff hanya berisi pekerjaan getPayment DOIT (adapter baru, lookup, parser status, test).
- Sub-brief asal: `docs/briefs/sub-doit-get-payment.md` (fakta, desain, dan daftar test). Boleh dibaca untuk konteks, tetapi review dilakukan terhadap diff, bukan terhadap niat di sub-brief.
- Berkas utama yang harus dibaca:
  - `apps/api/src/services/payment-doit-wire.ts` (skema status `doitPaymentStatusSchema` sekitar baris 102, `verifyDoitSignature` sekitar baris 550, `doitPaymentToProviderStatus`, `doitPaymentToProviderResult`)
  - `apps/api/src/services/payment-doit.ts` (`lookupPayment`, `call()`, `getStatus` sekitar baris 602)
  - `apps/api/src/services/payment-doit-provider.ts` (file baru: `createDoitPaymentReader`)
  - `apps/api/src/services/payment-webhook.service.ts` (dedupe event id sekitar baris 1189, `onConflictDoNothing`)
  - `apps/api/src/services/payment-gateway.ts`, `packages/shared/src/adapters/providers.ts` (kontrak port dan enum status)
  - Test: `apps/api/src/test/payment-doit-get-payment.test.ts`, `apps/api/src/test/payment-doit.test.ts`
- Dokumentasi DOIT: https://doit.id/docs/en/ (cek bagian webhook dan signature).

## Fakta yang sudah dipetakan (verifikasi, jangan terima begitu saja)

- Status DOIT hanya 5: pending, paid, refunded, expired, failed. Enum provider punya 6 (ditambah cancelled). Status tak dikenal harus jadi galat, tidak pernah `paid`.
- `GET /v1/payments/{id}` memakai id DOIT (providerRef), bukan reference Legend.
- `verifyDoitSignature` diklaim sesuai docs: header `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>`, `timingSafeEqual`. Verifier tidak boleh diubah; tugasmu menilai apakah klaim ini benar.
- Toleransi waktu 25 jam dan 5 menit: ini ASUMSI, belum ada di docs yang sudah terbaca. Jangan anggap benar. Cek docs. Bila tidak bisa dipastikan dari docs, tulis sebagai "tidak terverifikasi" dan jelaskan dampaknya.

## Pertanyaan review

1. Status tak dikenal ("settled", "cancelled", string kosong, angka, null) tidak pernah jadi `paid`. Galat dicatat tanpa nilai body.
2. Refunded tidak hilang. `refunded` tetap `refunded`, tidak diturunkan ke `pending` atau `paid`, dan tidak di-clamp ke status lain.
3. Galat jaringan, timeout, HTTP 5xx, dan 429 tidak mengubah status lokal. Adapter ini tidak menulis apa pun.
4. Id, reference, atau tenant yang tidak cocok ditolak (`malformedProviderAnswer()` atau `NOT_FOUND` sesuai desain). Periksa juga kasus `providerRef` benar tetapi `reference` di jawaban salah, dan sebaliknya.
5. Verifier tanda tangan: sesuai docs DOIT? Periksa urutan string yang ditandatangani, format header, parsing `t` dan `v1` (termasuk beberapa `v1`), perbandingan panjang buffer sebelum `timingSafeEqual`, dan toleransi waktu. Tandai toleransi 25 jam dan 5 menit sebagai tidak terverifikasi bila docs tidak menyebutnya.
6. Dedupe event id di `payment-webhook.service.ts:1189`: apakah `onConflictDoNothing` benar-benar mencegah pemrosesan ganda? Apakah event yang gagal di tengah proses bisa tertandai "sudah diterima" dan hilang? Apakah dua worker bersamaan aman?
7. Logging: tidak ada kredensial, body respons, header, atau secret webhook di log, error, atau respons API (PAY-06).

## Laporan

Satu laporan.

- Temuan diurutkan dari yang paling berat (blocker, tinggi, sedang, rendah).
- Tiap temuan: file:baris, pertanyaan nomor berapa yang dilanggar, skenario gagal konkret (urutan kejadian dan data), dan usulan fix.
- Tulis "Tidak ada blocker" bila memang tidak ada.
- Pisahkan dengan jelas: (a) yang sudah dibuktikan dari kode atau docs, (b) yang tidak terverifikasi.
- Boleh reproduksi dengan test sementara lewat `LEGEND_TEST_FILES="<file>" pnpm test` dari root worktree. Bersihkan sesudahnya dan jangan tinggalkan berkas baru.
