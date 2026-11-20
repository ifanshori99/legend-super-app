# 1209 Hardening deploy pra-rilis (20 Nov)

Sumber: verifikasi checklist keamanan `docs/deployment.md` (~baris 701-713, 13 item) di int/batch100. Peran: engineer. Tingkat S (bukan uang).

## Setup
`command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-1209" -b ws/1209-hardening-deploy int/batch100`, lalu di worktree itu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Path berisi spasi: kutip.

## Kerja
1. Item 1: `apps/api/src/config/env.ts` menolak `http://` untuk `BETTER_AUTH_URL` dan `WEB_URL` (juga `VITE_API_URL` bila divalidasi di sana) saat `NODE_ENV=production`, KECUALI host `localhost`/`127.0.0.1`/`[::1]` (e2e memakai production build di localhost). Fail-first test di test env yang sudah ada (cari `env.test` atau test config).
2. Item 9: `deploy/caddy/Caddyfile`: `request_body { max_size ... }` per site (API JSON 1 MB cukup di atas cap 100 kB app; route upload pakai cap terbesar upload yang ada di kode, cari batas upload S3/ClamAV/lampiran) dan `timeouts` server (read_body, read_header, idle) yang wajar untuk upload lambat. Jalankan `caddy validate` bila caddy tersedia; bila tidak, tes konfigurasi yang ada (cari test yang membaca Caddyfile).
3. Docs `docs/deployment.md` checklist:
   - Item 3: langkah firewall (security group cloud ATAU chain DOCKER-USER, karena port Docker melewati ufw) + perintah cek `curl` ke IP origin ditolak + refresh rentang Cloudflare tiap kuartal (Caddyfile juga statis).
   - Item 8: tulis "compose satu instance API; sebelum >1 instance wajib Redis + `REDIS_URL`; limit Better Auth dan login-challenge masih per proses".
   - Item 10: perbarui teks: admin hanya `user: impersonate` lewat support grant.
   - Item 12: keputusan CTO: rilis awal tanpa verifikasi email/recovery email (belum ada provider email, bead legend-wwuc); login memakai alur WhatsApp/PIN yang ada. Aktifkan sesudah provider email siap.
   - Item 13: keputusan CTO: CSP nonce ditunda (risiko merusak SSR); header yang ada tetap. Bead P3 terpisah.
   - Item 2/4/5/6/7: tandai sebagai pengaturan operator dengan nama key dan nilai contoh dari `deploy/single-vm/runtime.env.example`.

## Bukti selesai
Fail-first test item 1 (merah sebelum, hijau sesudah) lewat `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test`. prettier --check + eslint berkas berubah. `heavy pnpm --filter @starter/api typecheck`. Commit per langkah (akhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), push cabang. Budget 50 tool call; di 40 commit dan lapor.
