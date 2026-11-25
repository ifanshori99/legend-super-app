# 1265 Latihan rilis (deploy dry-run, Caddy, dry-run PPh21)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-1265`, cabang `ws/1265-release-rehearsal` dari milestone/m1 9fcac9be1. Dua agent berbagi worktree ini, file tidak bertumpuk.

Aturan umum: path dikutip (ada spasi), `command git`, jangan `git stash`, jangan switch/reset branch, jangan merge/push ke main atau milestone. Jangan baca `.env*` atau rahasia apa pun; pakai nilai dummy buatan sendiri di folder scratch `mktemp -d`. Jangan menyentuh server, VM, domain, atau layanan luar. Test/build/tsc lewat `heavy`. Docker: `~/.claude/scripts/colima-up` dulu, bersihkan container/volume bernama milik sendiri sesudahnya (hanya yang kamu buat). Commit kecil hanya file sendiri, akhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, lalu push cabang. Bug produk yang ragu: pilih aturan paling membatasi dan laporkan. Laporan akhir maks 10 baris.

## Bagian A: deploy + Caddy (file: `deploy/**`, `docs/deployment.md`, `docs/release/rehearsal-2026-11-25.md`)

1. Jalankan `deploy/single-vm/deploy.sh --env-file <dummy> --dry-run` sungguhan dengan env dummy dari `compose.env.example`, `runtime.env.example`, dan berkas contoh lain. Semua skrip uji di `deploy/` (test-deploy.sh, test-scripts.sh, restore-drill.test.sh, edge, monitoring) dijalankan. Catat perintah, exit code, hasil.
2. Cocokkan nama kunci: yang dibaca `apps/api/src/config/env.ts` (dan worker/web) dibanding compose.yaml, contoh env, `docs/release/production-credentials-checklist.md`. Laporkan kunci wajib yang hilang atau salah nama; perbaiki contohnya.
3. Latihan dry-run gagal: env file hilang, refund flag API/worker beda, role belum ada. Harus berhenti dengan pesan jelas sebelum menyentuh database.
4. Review `deploy/caddy/Caddyfile` (dan `deploy/edge/Caddyfile.edge.example`): TLS, HSTS, header keamanan tidak dobel atau bentrok dengan app, batas body (API 100 kB, unggah file/foto, webhook Duitku/DOIT), timeout + SSE/WebSocket tidak terpotong, X-Forwarded-For tepercaya (Cloudflare di depan: IP klien asli, jangan bisa dipalsukan; API menolak TRUST_PROXY=true, jadi cek rate limit memakai apa), endpoint internal/metrics/health tidak terbuka, www/apex/subdomain tenant, log tidak menulis token/cookie/query rahasia. Validasi dengan `caddy validate` dan `caddy adapt` dari image Caddy yang dipin di repo (docker), plus smoke lokal bila murah.
5. Temuan nyata: perbaiki di cabang ini dengan test/skrip bukti bila mungkin. Kredensial tetap kosong.
6. Tulis hasil ke `docs/release/rehearsal-2026-11-25.md` (bagian Deploy dan Caddy): lulus, diperbaiki, sisa yang butuh VM/founder.

## Bagian B: PPh21 (file: `apps/api/src/scripts/payroll-pph21-receivable-backfill.ts`, service, test-nya, `docs/release/pph21-backfill-rehearsal.md`)

Bead legend-wxvt9. Staging belum ada, jadi latihan di database lokal sekali pakai.
1. DB sekali pakai baru, migrasi penuh sampai head. Isi data lama realistis: payroll yang sudah final dengan potongan PPh21, kasus piutang positif/negatif/nol, karyawan keluar, dua tenant, run yang dibatalkan/koreksi, data sebelum migrasi piutang PPh21, item yang seharusnya ditahan.
2. Jalankan `pnpm --filter @starter/api payroll:backfill-pph21-receivable --dry-run`: bukti nol tulisan (hash/jumlah baris sebelum = sesudah). Lalu tanpa --dry-run, lalu ulangi (idempoten: 0 perubahan). Coba putus di tengah dan dua proses bersamaan. Buktikan tidak ada karyawan dipotong atau dibayar dobel, dan tenant tidak bercampur.
3. "Isian 0558" di bead: cari migrasi/constraint yang dimaksud (nomor bisa berubah sesudah squash; cek `apps/api/drizzle` dan git log), uji terhadap data lama.
4. Bug nyata: test gagal dulu, lalu perbaiki. Test terarah hijau dan tsc api hijau.
5. Tulis langkah persis untuk staging/production (perintah, cara baca hasil, ambang berhenti, cara mundur) di `docs/release/pph21-backfill-rehearsal.md`. Jangan klaim staging sudah dijalankan.

## Gelombang 2: hasil review architect (25 Nov). Dua agent, berkas tidak bertumpuk.

### G1 (perintah ops di dist): `apps/api/tsup.config.ts`, `apps/api/package.json`, berkas wrapper baru, skrip yang disebut, dokumen perintahnya selain runbook PPh21
- Penjaga entry `payroll-pph21-receivable-backfill.ts:98-107`: dipanggil tanpa `.js` atau lewat symlink = exit 0 tanpa output. Ganti pola wrapper seperti `apps/api/src/reset-preswitch-refunds.ts` (wrapper selalu menjalankan, modul tidak punya penjaga).
- Masalah sama, pakai wrapper + entry tsup, urut penting: `db/backfill-ptkp-history.ts` (`docs/deployment.md:202`, wajib sebelum simulate payroll), `db:backfill-defaults`, `metrics:backfill`, `db:backfill-employee-managers`, `db:rotate-data-key`, `role:set`, `purchase-return:variance-check`, `db/repair-supplier-invoice-npwp.ts`. Penjaga `.ts$` lama = diam exit 0: hilangkan. Argumen salah/kosong = exit bukan 0 dengan usage, tidak menulis. Perilaku dan default (dry-run bila ada) tidak berubah.
- Test: tiap entry ada di tsup; build (lewat heavy) lalu jalankan `node dist/<x>.js` dengan argumen salah: keluar bukan 0 dan ada pesan. Perintah di dokumen diperbarui ke `docker compose ... run --rm --no-deps -T api node dist/<x>.js`.
- Smoke: salin dist + node_modules produksi (image api bila build murah, kalau tidak Node 22 lokal) dan jalankan dry-run PPh21 + PTKP ke DB sekali pakai.

### G2 (PPh21): `apps/api/src/services/payroll-pph21-receivable-backfill.service.ts`, `apps/api/src/test/payroll-pph21-receivable-backfill.test.ts`, `docs/release/pph21-backfill-rehearsal.md`
- Service `:181` `catch` menelan galat DB: tangkap hanya galat `unreadable`. Test gagal dulu.
- Laporan: rincian per badan hukum + sisa item yang sudah ada.
- Test `:1389-1395`: saring kunci yang ditunggu, jangan terminate backend test lain.
- Runbook: (1) tanpa baris `summary` = STOP. (2) pakai `run --rm --no-deps -T api node dist/payroll-pph21-receivable-backfill.js --dry-run`. (3) Ambang (putusan): STOP bila (sisa item yang ada + `createdIdr`) > saldo 1204 per badan hukum; selisih ke bawah dinilai accounting; STOP bila `summary.tenants` ≠ jumlah tenant, ada `employee_missing`/`id_taken`, atau hasil nyata ≠ dry-run; payroll dibekukan di antaranya. `payslip_unreadable`/`item_exceeds_balance`: lanjut hanya bila tiap nama dijelaskan tertulis HR/finance (tidak ditulis apa pun). Hapus "selisih besar". (4) Mundur: migrator `BYPASSRLS`, `BEGIN`, `DELETE ... RETURNING`, batasi badan hukum/id, jumlah ≤ hasil apply, baru `COMMIT`. Sudah ada pelunasan: jangan pulihkan backup; berhenti, hubungi CTO, perbaikan maju. (5) `pg_dump` sebagai superuser/migrator di container postgres, `umask 077`; tenant sebelum yang gagal sudah ter-commit; selesaikan reversal yang direncanakan dulu.
