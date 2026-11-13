# tj8o gelombang fix 3 (diff belum commit, apps/web/src/features/ws01-access/)

Jangan jalankan tsc/test. eslint+prettier file berubah. Tanpa tampilan baru di luar layar yang ada.

## Implementer A (milik: lib.ts, errors.ts, components/role-editor-page.tsx, packages/shared/src/i18n/messages/access.ts, tests/legend-tj8o-access-guards.test.mjs)
Architect (wajib): server menolak SELF_ELEVATION_FORBIDDEN bila editor mematikan MFA pada role yang ia pegang sendiri (apps/api/src/services/access.service.ts:571-588). FE salah menganggapnya soal izin tambahan (role-editor-page.tsx:355-364, errors.ts:78-83) -> loop re-auth. Perbaiki:
1. lib.ts: `viewerHoldsRole(viewerAssignments, roleId, now)` semua scope aktif.
2. role-editor-page: bila role.mfaRequired dan viewer memegang role itu, switch MFA tidak bisa dimatikan + teks alasan terlihat. `onSaveError` buka re-auth hanya bila `added` berisi izin yang tidak dipegang; saat gagal refetch viewerAssignments + allRoles.
3. errors.ts: `added` kosong -> kunci baru `access.role.mfaDropSelf` (tambah di access.ts).
4. Test gagal-dulu: mematikan MFA pada role yang dipegang sendiri.
Ui-auditor:
5. Blok re-verify: cabang `factors.isError` (teks error + tombol Coba lagi `factors.refetch()`, pakai access.grant.reauthUnavailable bila cocok), bukan "Aktifkan TOTP".
6. Setelah blok re-verify terbuka: scrollIntoView({block:"center"}) (hormati prefers-reduced-motion) + focus input kode; cabang no-factor/error fokus ke teksnya (tabIndex -1).
7. Setelah simpan sukses reset reauthOpen/reauthAt; status sukses hilang saat lewat ROLE_GRANT_REAUTH_MAX_AGE_MS; wadah role="status" kosong permanen, isi teks di dalamnya.

## Implementer B (milik: components/assignments-page.tsx saja)
1. Alasan blokir tombol End: di bawah `md` tampil di sel pertama di bawah nama (seperti scopeLabel md:hidden), kolom aksi hanya ikon kunci + "Terkunci" dengan aria-describedby ke teks lengkap; tanpa scroll horizontal di 320 px.
2. Error daftar Owner: satu banner error + satu tombol Coba lagi di atas tabel, bukan per baris; baris hanya ikon+label singkat.
