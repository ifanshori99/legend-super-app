# 193b result, architect 1 (review ganda Claude, brief 225)

Kartu: legend-cg071. Kode dibaca di `milestone/m1` (94d769c6) dan dicocokkan ke `integ/m1-batch31` (6fad1401): `middleware/support-session.ts` dan `middleware/auth.ts` sama; `lib/auth.ts` hanya menambah batas sesi ke kedaluwarsa grant (legend-npkpz).

Hasil: 1 temuan P2 (kartu baru legend-8bvin), sisanya OK.

## Per pertanyaan

1. Bypass. OK. Hanya `middleware/auth.ts:12`, `support-session.ts:188`, `identity-auth.routes.ts:63,88`, `kds-realtime-auth.ts:88` dan fallback dev `app.ts:334` membaca sesi cookie; semuanya dijaga. Guard `/api/auth` (`app.ts:273`) dipasang sebelum login-challenge, identityAuthRouter dan Better Auth. Allowlist cocok persis sesudah normalisasi (`support-session.ts:70-75`): path yang beda sedikit (encoded, `..`, huruf besar) jatuh ke pemeriksaan sesi lalu ditolak, jadi gagal tertutup. Tidak ada method override. HEAD/OPTIONS hanya baca. `/oauth/authorize` hanya redirect; persetujuan di `POST /api/ai/mcp/authorize` diblok.
2. Tenant binding. OK. Grant dicari per (tenant hasil resolusi, impersonatedBy) (`platform-support.service.ts:1361-1371`). Domain lain tanpa grant: 403. Tanpa tenant: gagal tertutup kecuali allowlist (`support-session.ts:146-150`). Rute identity di `/api/auth` tidak pernah dapat tenant (tenantContext `/api` dipasang sesudahnya), jadi keep-alive lolos lewat allowlist.
3. Grant. OK. Kedaluwarsa dibanding jam (`gt(expiresAt, now)`), `endedAt IS NULL`, pemegang harus masih platform admin (`:1383`), pemegang grant = impersonatedBy.
4. Error. OK. PlatformError ke 403 dengan JSON standar; kode hanya terlihat oleh admin yang meng-impersonate.
5. Performa. P3. Sesi normal di rute API tidak menambah query. Tapi `guardImpersonatedAuthRoutes` (`support-session.ts:187-191`) menambah satu lookup sesi DB untuk tiap request `/api/auth` non-allowlist yang membawa cookie, termasuk sesi normal (MFA, list-sessions, sign-in ulang). Rute identity lalu memanggil requireAuth lagi. Biaya kecil, catat saja.
6. Yang masih bisa diubah. Password, email, sesi, faktor MFA: tertutup (semua di `/api/auth`). Pemberian role dan write-off butuh `mfa_verified_at` yang tidak bisa didapat sesi impersonate: tertutup. Celah: web push (P2 di bawah).

## Temuan P1/P2

- P2 legend-8bvin. `apps/api/src/middleware/support-session.ts:49-62`: CREDENTIAL_PATHS tidak memuat `POST /api/notifications/push-subscriptions`. Dengan grant read_write, admin yang meng-impersonate owner bisa mengaktifkan push. Baris `push_subscriptions` (`apps/api/src/db/schema/notification.ts:182`) terikat ke user_id, bukan ke sesi. Akibatnya notifikasi owner tetap terkirim ke browser admin sesudah sesi 60 menit dan grant berakhir. Ini melanggar aturan 7 di file yang sama. Saran: tambah regex path itu ke CREDENTIAL_PATHS dan test read_write -> 403 di `support-session-readonly.test.ts`.

## P3

- Lookup sesi ekstra di guard `/api/auth` untuk sesi normal (lihat 5).
