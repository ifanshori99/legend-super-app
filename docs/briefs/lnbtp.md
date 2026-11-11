# lnbtp — WA login confirm wajib + "Bukan saya"
Worktree: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/lnbtp (branch ws/lnbtp-wa-confirm-required). Hanya edit di sini.
Kartu: `bd show legend-lnbtp`. Route: apps/api/src/routes/identity-auth.routes.ts (~baris 103, requireConfirm).
Tujuan:
1. requireConfirm wajib untuk SEMUA login WA; klien tak bisa mematikan (false/absen = true atau ditolak sesuai kontrak). Sesi dibuat hanya setelah confirm.
2. "Bukan saya": batalkan tantangan; JANGAN kirim balasan WA "berhasil"; akun yang dibuat otomatis untuk pengirim pada tantangan itu dirapikan (hapus/nonaktifkan bila belum pernah dipakai; jangan sentuh akun yang sudah ada sebelumnya).
3. Test balapan cancel vs poll/confirm (dua permintaan bersamaan): tidak ada sesi tercipta setelah cancel.
4. Web (f6fc4d01) sudah kirim requireConfirm:true; e2e mock kmndq tetap lulus.
Scope: API identitas/login WA + test. Migrasi bila wajib: nomor 0279 (sementara).
Test: vitest backend di apps/api/src/test/...; jalankan `LEGEND_TEST_FILES="<path>" heavy pnpm test` (hanya satu pemegang token heavy).

## Desain (engineer, dari hasil Explore)
- Route `apps/api/src/routes/identity-auth.routes.ts:103`: kirim `requireConfirm: true` selalu (nilai klien diabaikan; schema tetap boleh `requireConfirm?: boolean`). Service `issueWhatsAppChallenge` (identity-login.service.ts:264) tetap: confirmRequired = requireConfirm && !link.
- Balasan WA: `identity-wa-inbound.service.ts:495-503`: bila challenge.confirmRequired, JANGAN set pendingReply "success" (balasan "Login berhasil" dikirim sebelum browser confirm). Balasan "error" tetap. Jalur link (L455) tidak berubah.
- Akun otomatis: `resolveWhatsAppAccount` (identity-account.service.ts:52) mengembalikan `created`, dibuang di inbound L480. Simpan ke kolom baru `login_challenges.auto_created_user_id text null` (migrasi 0279_wa_login_auto_account.sql, ikuti pola 0274; jangan buat snapshot drizzle, merge train). Isi di completeChallenge saat created=true.
- Cancel (`cancelWhatsAppChallenge` identity-login.service.ts:703): hanya bila flip ke cancelled benar-benar berhasil (flipped.length===1) DAN row.autoCreatedUserId != null: hapus akun itu (context.internalAdapter.deleteUser, atau pola yang ada) HANYA bila belum pernah dipakai: tidak ada sesi, tidak ada challenge lain (id != ini) dengan matchedUserId sama yang bukan cancelled, hanya satu identitas whatsapp, tak ada keanggotaan tenant/pesanan. Ragu = jangan hapus (akun ditinggal, tercatat di audit). Akun lama (created=false) tak pernah disentuh. Cek FK login_challenges.matched_user_id agar hapus tidak gagal/cascade-hapus baris audit; audit "login_challenge.cancelled" mencatat `autoAccountRemoved: boolean`.
- Balapan: cancel vs poll/confirm sudah memakai UPDATE bersyarat (sessionIssuedAt null); test harus membuktikan tak ada sesi setelah cancel.

## Perbaikan test lama (gelombang 2)
requireConfirm kini wajib di route: sign-in WA lewat HTTP `POST /api/auth/login-challenges/whatsapp` -> webhook -> poll TIDAK lagi memberi sesi sebelum `POST /api/auth/login-challenges/:id/confirm` (binding cookie sama; lihat identity-wa-masked-login.test.ts untuk pola confirm). Test lama yang polling langsung mengharapkan `session` harus menambah langkah confirm (lewat helper bersama bila ada) — JANGAN melemahkan asersi. Link (browser sudah login) tak butuh confirm.
Log run gagal (baseline berkontaminasi: FK identity_merges karena cleanup test gagal): /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/2cf42ab8-aa9b-43f7-b501-9cbad0a7414d/scratchpad/clean.txt (grep nama file test Anda). Jangan jalankan test/tsc.

## Temuan architect (gelombang 3)
T1 (sedang): balapan cancel A vs inbound B (nomor sama, resolveWhatsAppAccount created=false lalu cancel A menghapus akun X sebelum commit B; B menunjuk user terhapus, matched_user_id tanpa FK). Perbaikan: (a) `removeUnusedAutoAccount` (identity-login.service.ts ~:721): sebelum cek jalankan `SELECT 1 FROM "user" WHERE id=${userId} FOR UPDATE`; tak ada baris = return false; cek sesudah kunci. (b) `completeChallenge` (identity-wa-inbound.service.ts ~:783): sebelum UPDATE `SELECT 1 FROM "user" WHERE id=${input.userId} FOR KEY SHARE`; tak ada = "refused". (c) test balapan: inbound B ditahan lewat deps.resolveAccount (hook) antara resolve dan complete + cancel A: tak boleh ada challenge menunjuk user terhapus.
T2 (rendah): cek profil di removeUnusedAutoAccount (~:731) buta lintas tenant (FORCE RLS): ganti dengan `OR EXISTS (SELECT 1 FROM app.member_profiles_of_user(${userId}))` (SECURITY DEFINER, sudah grant di 0203; verifikasi nama/signature di drizzle/0203*).
