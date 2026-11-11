# 487 Mockup gate-ui: kasir tambahan (WS-04) + back-office/platform/keamanan

Peran: designer (`~/.agents/team/roles/designer.md`). Arah visual sudah disetujui: ikuti `DESIGN.md`, `~/.agents/team/ui-standard.md`. Lewati langkah "dua arah": langsung layar final. Isi nyata dari PRD `../PRD_Legend_Super_App_v1.7.md` (`bd show <id>` untuk tiap kartu). Bahasa UI Indonesia. Tiap layar: keadaan normal, kosong, error, dan loading bila relevan; 390 dan 1280 bila layar dipakai di keduanya.

Kerja di worktree sendiri dari cabang `ux/customer-order-benchmark`, cabang `design/mockups-487-<a|b>`. Commit html + png di cabangmu, push cabang, lalu lapor (daftar berkas, kartu, hal yang perlu keputusan founder).

## Bagian A (thread A): WS-04 kasir tambahan, folder `design/mockups/pos/`
Ikuti gaya `common.css`, `common.js`, `render.mjs`. JANGAN ubah `README.md`, `render.mjs`, `supervisor.html`, `shift.html` (thread lain sedang mengedit folder ini); catat layar barumu di `design/mockups/pos/README-extras.md`. Cek dulu `supervisor.html` (refund/void) dan `shift.html`: kartu yang sudah tercakup cukup dilaporkan, tidak digambar ulang.
- legend-1uk9: halaman struk elektronik publik `/r/$token` (390).
- legend-shabi: tombol "Tagih selisih" (charge order).
- legend-pspy: cash-out "perlu persetujuan" + heldCashOutIdr di jejak shift.
- legend-0ixe: pemberitahuan void dari KDS ke kasir.
- legend-hn5q: rilis/buka ulang karantina refund.
- legend-kfkt: refund ditolak/coba ulang + failureReason.
Berkas: `pos-extra-<kartu>-*.html/png`.

## Bagian B (thread B): back-office, platform, keamanan
Ikuti gaya `design/mockups/platform/support-access.html` dan `design/mockups/ai/admin.html` (tampilan admin). Folder `design/mockups/platform/` (platform) dan `design/mockups/backoffice/` (tenant).
- legend-nb4iy: Platform, pulihkan tenant terarsip / outlet tertutup.
- legend-be0lx: Platform, tetapkan atau ganti Owner tenant.
- legend-az8z5: verifikasi domain kustom lewat TXT.
- legend-sw980: kode cadangan MFA.
- legend-7z38l: editor satuan (UOM) tenant.
- legend-fzvh: editor pemetaan akun-peran (account-role mappings).

Paralel: subagent Codex per kartu (maks 6), satu reviewer gambar di akhir terhadap `ui-standard.md`. Laporan: berkas, kartu, angka subagent.
