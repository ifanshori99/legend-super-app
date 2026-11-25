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
