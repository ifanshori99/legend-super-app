# Brief lanjutan G88uh: WS-11 berkas bersama, putaran 1 (`ws11-shared`)

Lanjutan di thread yang sama. Aturan sama dengan brief 260. Cabang baru `ws/ws11-shared-1` dari `ws/ws11-foundation` (eb4383cb), worktree baru `.worktrees/ws11-shared-1`. Jangan push, jangan merge. Tanpa migrasi; bila perlu, berhenti dan lapor.

## Keputusan CTO
- `legend-svrzc`: samakan `GET /api/metrics/query` dengan aturan report run, yaitu cek izin per laporan sumber dan daftar putih agregat se-tenant. Panggilan yang dulu lolos lewat agregat tanpa izin kini 403 `REPORT_NOT_PERMITTED`. Sebut pemanggil web yang terdampak.
- Second opinion Codex 260b: antre sesudah 15 Nov (xhigh), wajib sebelum gerbang rilis. Tidak menahan kerja.

## Tujuan (satu commit per butir)
1. `legend-svrzc` seperti di atas. Test gagal-dulu: tanpa izin laporan sumber 403; dengan izin di outlet sendiri lolos; agregat se-tenant hanya untuk metrik di daftar putih.
2. Bucket selain `total` di report run: baris laporan membawa kolom bucket (day, week, month sesuai kontrak) supaya 4 laporan `defaultBucket: "day"` menjawab baris. Buat kartu `ws11-shared` untuk tiap butir dan tutup di akhir.
3. groupBy lebih dari outlet + 1 dimensi, bila murah. Bila tidak, catat batasnya di kontrak dan kartu.

Kartu F1-F12 sedang dikerjakan paralel di cabang lain dari eb4383cb dan memakai berkas keluarganya sendiri. Kamu tetap satu-satunya yang mengubah `metrics-query.service.ts`, `packages/shared/src/dashboard/*`, `packages/shared/src/metrics/*`, dan `reports.routes.ts`. Bila thread keluarga minta perubahan berkas bersama lewat CTO, itu masuk putaran berikut.

## Bukti dan review
Sama dengan brief 260: test terarah, test root ws11 + kontrak lewat `node --test`, typecheck lewat `heavy` sekali, eslint + prettier. Review tingkat K: satu `architect`.

## Laporan
Sekali di akhir: per butir (hasil, SHA), kartu baru, bukti, kontrak yang berubah untuk thread keluarga, risiko, jumlah subagent dan puncak bersamaan.
