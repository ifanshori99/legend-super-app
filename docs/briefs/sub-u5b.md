# Sub-brief U5b: 12 layar konfigurasi tenant (ui-engineer)

Worktree: /Users/ifanshori99/Projects/legend super app/legend-0d311cc8 (cabang `ui/tenant-config`, basis `milestone/m1`).
Checkout utama (read-only, cabang `ux/customer-order-benchmark`): /Users/ifanshori99/Projects/legend super app/legend
- Brief induk: legend/docs/briefs/539-u-areas.md baris U5 ("12 layar konfigurasi (496, wwyyk, 498; split-claim-wwyyk.html)").
- Mockup: legend/design/mockups/ (README.md = daftar; split-claim-wwyyk.html + PNG; subfolder backoffice/ platform/ dll).
- Brief lama sub-ui-bo-config.md dan sub-ui-bo-config-cards.md di legend/docs/briefs/ (brief 505, cabang origin/ws/ui-bo-config).
- "496", "498" kemungkinan nomor brief/kartu: cek legend/docs/briefs/496*, 498*, `bd show`/`bd search`, README mockup, git log.

Aturan: jangan sentuh API uang/auth. Teks UI baru didaftarkan ke katalog (pra-gate AGENTS.md). UI ikut ~/.agents/team/ui-standard.md.

## 12 layar (dari review-q29.html; M = /Users/ifanshori99/Projects/legend super app/legend/design/mockups)
| Q | Layar (kartu) | Mockup HTML |
|---|---|---|
| 29 | Aturan pajak (woc1) | M/backoffice/tax-woc1.html |
| 30 | Peringatan nonaktifkan pajak terakhir (d5pz) | M/backoffice/pajak-peringatan-d5pz.html |
| 31 | Jurnal manual: outlet per baris (5ac3) | M/backoffice/jurnal-outlet-5ac3.html |
| 32 | Edit item menu: stasiun (0frf) | M/backoffice/menu-stasiun-0frf.html |
| 33 | Hub Pengaturan tenant (j0kd) | M/backoffice/settings-hub-j0kd.html |
| 34 | Bagi tagihan: klaim bagian saya (wwyyk), mobile saja | M/split-claim-wwyyk.html |
| 35 | Status edge: nomor struk berulang (s7szu) | M/backoffice/receipt-run-s7szu.html |
| 36 | Payroll: kebijakan pertama (wpqs) | M/hris/payroll-wpqs.html |
| 37 | Payroll: jadwal THR (wpqs) | M/hris/payroll-wpqs.html (state thr-*) |
| 38 | Preferensi notifikasi (rp3fk) | M/platform/notification-preferences-rp3fk.html |
| 39 | Sarapan setelah shower (ijv8) | M/pos/pos-extra-ijv8-sarapan.html |
| 40 | Label prep (wjz1) | M/pos/pos-extra-wjz1-label-prep.html |
PNG state: `<nama>-<state>-desktop|mobile.png` (pos: -1280/-390). Kartu bd: `bd search <kode>` (mis. woc1).

## Tugas pencocokan (Explore)
Untuk tiap Q: cari di worktree (= milestone/m1) route/komponen yang sudah membangun layar itu (grep kode kartu, judul, field kunci) dan hook/endpoint API + kontrak shared. Bandingkan dengan HTML mockup (state yang digambar). Verdict: SUDAH (sesuai mockup) / SEBAGIAN (sebut yang kurang) / BELUM. Sertakan path file dan status kartu bd.
