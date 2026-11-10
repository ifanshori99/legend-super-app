# 193b hasil architect 2 (review ganda Claude, Q43)

Kode: milestone/m1 94d769c6. Guard sekarang juga memuat CREDENTIAL_PATHS dan atribusi audit (5ec53979, rzirp/6yfhc).

Hasil: temuan (1 P1 baru).

## Per pertanyaan
1. Bypass: requireAuth adalah satu-satunya pemanggil getSession untuk router cookie /api (middleware/auth.ts:12-23). Pemanggil lain: tenant fallback dev (app.ts:325, hanya baca), identity login-challenge (identity-auth.routes.ts:63-70, sudah cek impersonatedBy), KDS realtime (kds-realtime-auth.ts:98-107, cek grant). Notifikasi realtime deny-by-default (server.ts:86). /oauth/authorize tidak memakai sesi; persetujuan lewat /api/ai/mcp/authorize (CREDENTIAL_PATHS). Tidak ada method override. HEAD/OPTIONS aman (CORS menjawab preflight). pathOf (support-session.ts:70-75) lower-case dan potong slash; allowlist exact-match, jadi path ter-encode atau `..` jatuh ke cek sesi (fail closed). OK.
   BUG P1 legend-imdzn: endpoint plugin admin Better Auth (/api/auth/admin/set-user-password, list-users, update-user, set-role, ban-user, remove-user) bisa dipakai sesi admin NORMAL tanpa grant. permissions.ts:41-42 memberi adminAc penuh; hook lib/auth.ts:84 hanya menjaga impersonate-user. Admin reset password owner lalu sign-in biasa; owner tanpa faktor MFA bisa diambil alih (identity-mfa.service.ts:127 izinkan faktor pertama tanpa sesi terverifikasi). Role Better Auth tidak ikut dicabut saat platform_admins.revoked_at diisi.
2. Tenant binding: grant dicek untuk tenant hasil findTenantContext (domain/device token/fallback dev), sama dengan tenant yang dipakai route. Tanpa tenant: tolak kecuali allowlist (support-session.ts:146-149). OK.
3. Grant: endedAt null, expiresAt > jam API (platform-support.service.ts:683-686), holder harus platform admin aktif (:700), grant dicari per impersonatedBy (:684). Jam API vs DB tidak diselaraskan (P3). Sesi impersonate yang grant-nya berakhir tetap ditolak per request; mematikan sesi = legend-w1due (terbuka).
4. Error: PlatformError lewat error handler, kode saja. OK.
5. Performa: sesi normal tanpa query tambahan di requireAuth. P3: guard /api/auth (support-session.ts:186-191) memanggil getSession ekstra untuk tiap path /api/auth non-allowlist yang membawa cookie (mis. sign-in dengan cookie lama).
6. Yang masih bisa diubah sesi impersonate: /api/auth/* tertutup kecuali allowlist (password, email, MFA, sesi). Role grant butuh mfa_verified_at sesi (access.routes.ts:101), sesi impersonate tidak punya dan /mfa/verify tertutup. Device/edge/PIN/MCP tertutup di CREDENTIAL_PATHS. OK.

## P3
- Skew jam API/DB pada expiresAt (gt pakai new Date() API).
- getSession ganda di guard /api/auth.
