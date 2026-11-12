# Sub-brief 539-U5a: back-office, platform, keamanan (6 layar)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/backoffice-platform` (cabang `ui/backoffice-platform`, dari origin/milestone/m1). Kerja HANYA di worktree ini. Jangan merge/push.
Aturan: `~/.agents/team/ui-standard.md`, `DESIGN.md` repo. Bahasa UI Indonesia. Ikuti mockup persis (tata letak, hierarki, copy). Semua API sudah ada di m1: pakai kontrak di `packages/shared` + API client yang ada; JANGAN tulis backend. Tiap layar: loading (skeleton), kosong, error, sukses, validasi sesuai mockup; desktop 1280 + mobile 390.
Mockup ADA DI CHECKOUT UTAMA (bukan worktree): `/Users/ifanshori99/Projects/legend super app/legend/design/mockups/`. Mockup (HTML = sumber copy/struktur; PNG per keadaan): `design/mockups/platform/` dan `design/mockups/backoffice/`. Baca hanya mockup layarmu.

| Kode | Kartu | Layar | Mockup | API |
|---|---|---|---|---|
| S1 | legend-nb4iy | Platform: pulihkan tenant diarsip / outlet ditutup (30 hari) | platform/restore-nb4iy.html | GET /api/platform/tenants/:tenantId/restore-window, .../outlets/:outletId/restore-window; POST .../restore, .../outlets/:outletId/restore {reason ≥10}; 409 RESTORE_WINDOW_EXPIRED, RESTORE_NOT_AVAILABLE, INVALID_TRANSITION |
| S2 | legend-be0lx | Platform: tunjuk/ganti Owner tenant | platform/owner-be0lx.html | POST /api/platform/tenants/:tenantId/owners; POST .../owners/:assignmentId/replace (reason, mfaCode TOTP) |
| S3 | legend-az8z5 | Org settings: verifikasi domain kustom TXT | platform/domain-verification.html | DTO domain.verification {type:TXT,name,value}|null; POST /api/org/domains/:domainId/verify; 422 DOMAIN_RESERVED, DOMAIN_VERIFICATION_FAILED; 409 DOMAIN_TAKEN |
| S4 | legend-sw980 | MFA kode cadangan (tampil sekali setelah enrol + "pakai kode cadangan" di login MFA) | platform/mfa-recovery-sw980.html | GET/POST /api/auth/mfa/recovery-codes; POST /api/auth/mfa/recovery |
| S5 | legend-7z38l | Editor satuan (UOM): tambah + ubah nama, bawaan terkunci | backoffice/uom-7z38l.html | POST /api/inventory/uoms; PATCH /api/inventory/uoms/:uomId (layar read-only legend-qdc sudah ada) |
| S6 | legend-fzvh | Pemetaan akun-peran per legal entity | backoffice/account-role-mappings.html | listAccountMappings/replaceAccountMappings + accountMappingIssues di @starter/shared/accounting |

Hasil Explore: `docs/briefs/sub-539-u5a-map.md` (ditulis agent utama dari laporan Explore).
Implementer: buat/ubah hanya berkas layarmu (route + komponen fitur + test komponen). Komponen bersama baru: lapor dulu, jangan edit berkas bersama yang dipakai layar lain kecuali disebut di map. Test komponen terarah (vitest) untuk keadaan utama. Jangan jalankan tsc/vitest/build sendiri kecuali diminta (satu token heavy per thread); laporkan perintah test terarahmu.
