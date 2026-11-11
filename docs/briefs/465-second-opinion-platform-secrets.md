# Brief: second-opinion Codex — area platform: kunci enkripsi + akses support

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only: jangan edit, jangan commit. Effort xhigh (akses dan kunci).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis pembanding `origin/milestone/m1` (3c7217b2).

## Cabang
`origin/ws/dheu-secrets-support` 4dfd3ceb:
- legend-dheu: key ring `DATA_ENCRYPTION_KEYS` + `DATA_ENCRYPTION_ACTIVE_KEY_VERSION` (1..255), byte versi amplop = versi kunci, `rotateIntegrationCredentials` segel ulang, `sealSecretBaseKey` untuk HRIS/payroll, `blindIndex` tetap kunci 1.
- legend-ca4l: migrasi 0287 `app.support_access_grant_tenants` (SECURITY DEFINER, hanya id tenant, EXECUTE hanya `legend_app`); list global/end/impersonasi hanya tenant ber-grant.
- legend-8en8: `POST /api/org/support-access/:grantId/revoke` (owner, MFA, bukan sesi impersonasi), sesi support tertaut berakhir, cause `revoked_by_tenant_admin`.

## Fokus
Data tidak bisa dibuka lagi setelah rotasi (versi salah, kunci 1 dipensiunkan, HRIS/payroll ikut pindah), kebocoran lintas tenant lewat fungsi SECURITY DEFINER (search_path, argumen, RLS), revoke yang tidak memutus sesi aktif atau bisa dipanggil tenant lain, impersonasi yang lolos guard, audit yang menyimpan rahasia, migrasi 0287 di data lama, urutan `when` migrasi setelah renumber.

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent: total, puncak bersamaan.
