# 806 lanjutan: temuan architect xhigh (tingkat K)

Basis: worktree ini, diff belum di-commit. Brief awal: `docs/briefs/806-panic-second-opinion-fix.md`. Jangan jalankan test/tsc (engineer yang menjalankan lewat `heavy`). Jangan sentuh edge, DOIT, payout, HRIS, pemindai.

## Hasil run test API (log `bzhz7jzrl`): 3 gagal

1. `panic-push-fanout.test.ts:507` "skips a subscription whose device was revoked...": seed (`seedSubscription`, ~263-295) membuat device tanpa `token_issued_at` dan baris push tanpa `device_token_issued_at`; dispatch baru (P1-2) mensyaratkan keduanya sama. Perbaiki seed: device `token_issued_at = now()` (kolom ada di `devices`), push `device_token_issued_at` = nilai yang sama bila ada device.
2. `push-registration-806.test.ts:359` revoke-other-sessions: orphan tetap (= defect A1 di bawah).
3. `push-registration-806.test.ts:556` cleanup `user_id = ANY($1::text[])` → `uuid[]` (user_id uuid).

## Defect architect

- A1 (P1-1, `apps/api/src/lib/auth.ts` ~586-600): `/revoke-other-sessions` Better Auth hanya menghapus sesi lain yang masih hidup; hook delete tidak terpanggil bila tidak ada sesi lain → orphan push user tetap. Fix: `hooks.after` (createAuthMiddleware, lihat after yang sudah ada ~377) untuk `ctx.path === "/revoke-other-sessions"` dan respons sukses: `deleteUserPushSubscriptions(userId, currentSessionId)` (sesi pemanggil dari `ctx.context.session` atau `getSessionFromCtx`; cek di `node_modules/better-auth/dist` mana yang tersedia di after hook). Tidak tahu sesi sekarang → lewati (alarm berlebih lebih baik daripada hilang) dan log warn. Gagal hapus → lempar. Cabang `/revoke-other-sessions` di `session.delete.before` boleh tetap hanya menghapus push sesi yang dihapus (tanpa sweep user).
- A2 (P2, `auth.ts:586`): hook hanya mengecualikan `/get-session`; endpoint lain (mis. `/list-sessions`, `/update-user`) dengan cookie kedaluwarsa memicu cleanup internal dengan path endpoint luar → push HP idle terhapus. Fix: allowlist path pengakhiran sengaja: `/sign-out`, `/revoke-session`, `/revoke-sessions`, `/revoke-other-sessions`, `/change-password`, `/delete-user`, `/delete-user/callback`, dan `path.startsWith("/admin/")`. Path lain/tanpa path → kembali tanpa menghapus. Update komentar.
- A4 (P2, `apps/api/drizzle/0379_panic_push_second_opinion.sql`, `app.claim_push_endpoint`): `NOT (tenant=p_tenant AND user=p_user)` juga menghapus baris orang yang sama di tenant lain. Fix: hapus hanya `user_id <> p_user` (endpoint sama, akun lain, tenant mana pun). Migrasi belum rilis, boleh diubah langsung; snapshot tidak berubah (fungsi SQL saja). Cek komentar di `notification-center.ts` registerPush yang menyebut perilaku claim.
- A3 (web) dikerjakan engineer: `legend.push.ownerEndpoint`; `unsubscribeThisBrowser(onlyEndpoint?)` hanya unsubscribe bila endpoint sekarang sama; guard dan revoke meneruskan endpoint tersimpan.

## Test gagal-dulu baru

- T-A1 (`push-registration-806.test.ts`): orphan + sesi lain yang sudah kedaluwarsa tapi barisnya masih ada (jangan di-cleanup) atau tanpa sesi lain sama sekali → `/revoke-other-sessions` dari login baru → hanya push sesi sekarang tersisa.
- T-A2: register, kedaluwarsakan sesi (expires_at lampau, baris tetap), panggil endpoint non-logout (mis. GET `/api/auth/list-sessions`) dengan cookie itu → baris push tetap (session_id NULL atau sama), tidak terhapus.
- T-A4: satu user anggota tenant A dan B daftar endpoint sama di keduanya → dua baris (satu per tenant). User lain daftar endpoint itu → baris user pertama hilang di semua tenant.
- T-A3 (`tests/push-registration-806-web.test.mjs`): owner A tersimpan dengan endpoint E1; browser sekarang punya E2 (B baru subscribe, belum simpan) → guard dengan user B tidak memanggil unsubscribe pada E2; revoke sign-out dengan endpoint tersimpan E1 sementara browser punya E2 → E2 tidak di-unsubscribe. Tanpa endpoint tersimpan (legacy) → unsubscribe seperti dulu.
