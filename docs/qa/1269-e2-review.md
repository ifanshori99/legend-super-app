# Review E2 (8686e8d03, 26 Nov): TIDAK LULUS, tanpa P0

Path `apps/api/src/` kecuali disebut lain. Urutan: P1-1, C, A+B, P2-2/3/4, P2-1, lalu re-review diff.

- P1-1 `edge/identity-freshness.ts:41,63-71`: jam tepercaya dibandingkan cap jam dinding (`device-registry-puller.ts:218`, `people-snapshot-apply.ts:768,812`, `runtime.ts:1187,1275,1311`). Jam melompat >72 jam lalu dibetulkan = login/override tertolak terus walau online. Cap identitas tersendiri dari jam tepercaya (contoh `catalog-freshness.ts:359`); `now` puller jangan diubah. Test dengan puller asli.
- P1-2/C `services/edge-device-auth.ts:57`, `routes/device-id.ts`: `edgeDeviceAuth` mengembalikan alasan; DEVICE_TOKEN_INVALID hanya untuk dicabut/dirotasi. Unknown, kedaluwarsa, beda outlet, hash beda = 401 UNAUTHORIZED, ditolak tetapi token web disimpan. Test: perangkat belum sinkron ke outlet-clock tidak kehilangan token; jam melompat tidak menghapus token.
- P2-1 `edge/cloud-http.ts:310-313`, `edge-device-sync.ts:~633`: fallback 400 melewatkan hash. Tarik ulang registry dari awal sekali per boot bila ada perangkat aktif ber-hash NULL; jumlahnya di health.
- P2-2 `people-snapshot-apply.ts:754`: hapus sesi edge staf banned/tanpa penugasan di transaksi yang sama.
- P2-3 `request-context.ts:97` gagal-terbuka tanpa konteks; `kds-realtime-auth.ts:217` WS tak memotong izin. Isi userId+authMethod di WS.
- P2-4 `packages/shared/src/edge/staff-session.ts:37-41`: buang 5 kode `pos.*.approve`.
- P3 ikut: `edge/mode.ts:81,85,86` cabut sign-in/email, sessions, mfa/verify; test `edge-staff-pin-session.test.ts:~374-430` pakai kode pasti.
- Migrasi 0524 aman; rollback hapus sesi edge_staff_pin dulu. Rilis: cloud, edge, terbitkan ulang token.

## Keputusan CTO

- A: ubah test, izin TIDAK ditambah. 4 test `edge-storage-upload-http.test.ts` mengharapkan 403 dan nol berkas/baris; kasus seal/keyless pindah ke jalur X-Pin-Proof. Absen edge = outlet-clock + bukti PIN + selfie.
- B: `middleware/session-origin.ts` masuk allowlist `shared-device-router-decisions.test.ts:522` dengan alasan "reads only to refuse a session of the other side, never authorises".
- `facility.*` dan QR absen tetap 403 di edge sampai kartu F1 membukanya dengan test.
- P1-3 (SSR `/api/me/access` 401 + halaman login PIN) dan P1-4 (override katalog owner di edge) = kartu sendiri, wajib sebelum edge dipakai outlet. P1-4: PIN owner + throttle penyetuju, bukan melonggarkan MFA.
- P3 RTC mati listrik dan kunci PIN jam dinding: bead.
