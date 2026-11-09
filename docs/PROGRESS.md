# PROGRESS — Legend Super App

Diperbarui 2026-11-08 ±19:50 oleh CTO (sesi G4tde "CTO baru"), serah terima ke CTO berikutnya.

## Workflow v3.3 diterapkan (2026-11-08 21:05)

Cabang milestone: `milestone/m1` (dari `main` 1f0b6d2). Slice yang lolos review Claude digabung ke sini (`--no-ff`, renumber migration via drizzle-kit). Gabung `milestone/m1` → `main` = gerbang rilis: tunggu semua antrean Codex tingkat K selesai + temuan nyata dibetulkan + klik founder.

### Tingkat per cabang

| Cabang | SHA | Tingkat | Alasan | Review Claude | Status |
|---|---|---|---|---|---|
| ws/pos-shift | 69ddb9a4 | K | uang kas, 5 migration | DIGABUNG m1 `30a31a3c` (prep 1eda3a4b, migration diregen 0088-0090); gate prep 2d7fe62a hijau API 2289 / root 1427; kartu 6c0 xvyr ditutup | Codex R1 brief 59 (rentang 71751c8f..30a31a3c) |
| ws/refund-approval | 09385266 | K | refund, approval, payout | DIGABUNG m1 `1056e208` (prep 55084e9c, migration diregen 0079); gate prep hijau API 1784 / root 1420; kartu rbjw hvvn ditutup | Codex R2 selesai: 2 P1 dibetulkan (ws 7c24b7b8) dan DIGABUNG m1 `baf6d615` (prep f5025cf9, migration 0091; gate API 2301 / root 1427) |
| ws/journals | 4ec3babb | K | jurnal | fix brief 78 selesai (G0msx, 2 Opus reviewer bersih); regen 0075/0076 di atas m1 8e2e7bc0; DIGABUNG milestone/m1 4e0bacd4 (brief 89, 00:2x); gate: lint+typecheck hijau, API 1496 + 9 file timeout diulang 147/147, root 1419 + 1 artefak diulang 21/21 | Codex R3 brief 70 (SHA 4ec3babb) |
| ws/payroll-pph21-tests | 461a94bf | K | uang PPh21 | DIGABUNG m1 `4a040820` (prep 53379722, migration diregen 0084/0085); gate prep hijau API 2147 / root 1426; kartu oo3q y4wp iwgb 5cnk ditutup; legend-s5c1 P1 prasyarat run service | Codex R4 (rentang 658b055b..4a040820; brief belum ditulis) |
| ws/edc-framework | a6d022d3 | K | uang EDC, tagih dobel | DIGABUNG m1 `658b055b` (prep 81038feb, migration diregen 0082/0083); gate prep hijau API 1961 / root 1426; kartu apt ditutup | Codex R5 brief 60 (rentang fd2616f4..658b055b) |
| ws/doit-provider | 8fed84ef | K | pembayaran, webhook | pasangan: FIX SELESAI (brief 80, G8x09; 2 review segar lolos) | Codex R5 brief 62 (SHA 8fed84ef) |
| ws/pos-receipt | d379023 | K | nomor struk, offline | pasangan: PERLU FIX (brief 77) | fix, lalu Codex R6 |
| ws/edge-registry-pull (+device-registry 7caa7be) | 3f8ffe38 | K | auth device, sinkron offline | Opus reviewer LOLOS + architect (thread) LOLOS; digabung ke milestone/m1 1e476101 (21:40); gate milestone lulus 21:44 (check 1414 test, build ok; journal when monoton > 0067) | Codex R6 |
| ws/stock-opname | 59e96f16 | K | nilai stok, akses counter | putaran 2 (brief 84) selesai, Opus reviewer bersih; DIGABUNG milestone/m1 7373f00b (migration 0070/0071); gate milestone lulus 22:30 | Codex R7 (SHA 59e96f16) |
| ws/recipe-bom | f0cec09 | K | HPP | pasangan gelombang 2 | Codex R7 |
| ws/procurement | ae09d1d | K | approval, nilai PO | architect sudah; fix brief 73 | Codex R8 |
| ws/ai-tool-catalog | d15542a | K | aksi AI berizin | pasangan gelombang 2 | Codex R8 |
| ws/tenant-config-export | 1405f19 | K | data keluar | pasangan gelombang 2 | Codex R9 |
| ws/shareholder-docs | f2760e4b | K | data pribadi, dokumen legal | malware fix cdc372c6; regen 0072/0073; DIGABUNG milestone/m1 55d90ab3 (22:45); gate milestone lulus 23:05 | Codex R9 |
| ws/reservation-selfservice | (G2m46) | K | token publik, deposit | setelah lapor | Codex R9 |
| ws/hris-leave | fa4ff73f (prep 05a14884) | S | cuti (Opus: domain rumit) | brief 85 selesai (G5klp); regen 0077/0078 di atas m1 4e0bacd4 (FK outlets/employees pola NO FORCE); DIGABUNG milestone/m1 e4938167 (brief 89); gate hijau: API 1723, root 1420 | selesai |
| ws/kds | 4a1f613 | S | dapur | architect sudah; fix brief 74 | gabung milestone |
| ws/hris-sop | 37aa5cd9 | S | SOP | DIGABUNG m1 `fd2616f4` (prep 9b981051, migration diregen 0080/0081); gate prep hijau API 1858 / root 1420; kartu 7df1 ditutup | selesai |
| ws/checklist-engine | e3ac2ef | S | checklist | Sonnet: PERLU FIX (board B11) | fix, lalu gabung |
| fix/worktree-shared | 4ab45cc | S | tooling | Sonnet: LOLOS | DIGABUNG milestone 4478360 |
| ws/print-agent | cb385ab | S | cetak (nomor dari receipt) | Opus reviewer gelombang 2 | gabung milestone |
| ui/pos-kasir-shift | 91a6c5e | S | UI mock | founder Q12 dilewati, tanya ulang | tunggu founder |

### Catatan merge milestone (WAJIB, dari architect jurnal)
Urutan merge (23:00): edge → stock-opname → shareholder-docs (55d90ab3) → reservation (8e2e7bc0, migration 0074, when 1794153034313) sudah → antrean siap: journals (merge-prep subagent regen ke 0075+), hris-leave, refund, hris-sop, edc, pph21, pos-shift, doit, receipt. CTO merge sesuai urutan siap; cabang berikutnya regen ulang di atas head m1 terbaru. Keputusan founder cuti bersama: mulai 2027-01-01 (sudah default).
Drizzle 0.45 hanya menjalankan migration dengan `when` > `created_at` migration terakhir yang sudah jalan. Migration cabang yang `when`-nya lebih tua dari 0067 di main akan DILEWATI diam-diam di DB yang sudah migrasi. Saat merge cabang ke `milestone/m1`: jangan sekadar ganti nomor; hapus migration cabang + snapshot lalu `drizzle-kit generate` ulang (when baru), SQL custom (RLS) disalin ke migration custom baru. Verifikasi: fresh DB + DB yang sudah di 0067 sama-sama lulus migrate.

Keputusan CTO 21:40: Codex dijalankan pada SHA setelah fix review Claude, supaya kuota tidak dipakai untuk temuan yang sudah diketahui. Jendela Codex yang datang sebelum ada fix siap: pakai untuk cabang K berikutnya yang belum direview (recipe/BOM, tenant config export, AI tool catalog).

### Antrean second-opinion Codex v3.3

Aturan: maks 1 run per akun ready, brief hanya rentang diff + berkas berisiko (±800 baris) + invariant PRD, tanpa temuan Claude. Codex hanya menahan gerbang rilis.

| Run | Isi | Effort | Brief | Jadwal |
|---|---|---|---|---|
| R1 | pos-shift + struk | xhigh | 59, 68 | tunggu gate (6c1ec83, 1657797e) via merge train |
| R2 | refund-approval | xhigh | 65 (SHA 09385266) | SELESAI 05:45 (G7110, akun 2): 2 temuan P1 yang terlewat review Claude: otorisasi refund di bawah ambang tanpa supervisor (:565), fund evidence_id NULL salah tujuan payout (:933). Fix brief 92 |
| R3 | journals | xhigh | 70 | jendela berikut |
| R4 | PPh21 | xhigh | menyusul | jendela berikut |
| R5 | EDC + DOIT | high | 60, 62 | DOIT SELESAI 06:00 (G8d4v, akun 3): 2 P1 (retry POST yatim :477, rekonsiliasi berhenti 60 dtk setelah expiry :1741) + 1 P2 (paid_at dibuang :274), terlewat review Claude. Fix brief 95 (reopen G8x09). EDC belum |
| R6 | struk + edge registry | high | 68, menyusul | |
| R7 | stok opname + recipe/BOM | high | menyusul | |
| R8 | procurement + AI tool catalog | high | menyusul | |
| R9 | config export + shareholder docs + reservasi | high | menyusul | |

Kuota: akun 2 dan 3 limit 5 jam (reset 23:36 dan 00:24), mingguan 32–37%. Perkiraan 9 run ≈ 5 jendela 5 jam.

## Serah terima CTO (2026-11-08 ±19:50, sesi G4tde compact 2x)

CTO baru: baca bagian ini dulu, lalu `ghostex coordinator status`. Brief thread ada di `docs/briefs/` (42–58).

### Siap merge (menunggu gerbang founder)
- `ws/db-role-provisioning` 4d08dac — 4 putaran review, terverifikasi Opus.
- `ws/fiscal-close-lock` bfe16fb — Codex: tanpa blocker, setuju dengan architect.
- `ws/edge-hardening` 2536ec6 — fix 0063 untuk migrator non-superuser (drop/restore FORCE RLS di transaksi), test 11/11, gerbang penuh hijau. Bead lanjutan `legend-jtnd` (role migrator production: superuser atau owner WITH BYPASSRLS; migrasi 0000–0062 butuh itu).
- `ws/pos-payment-fixes` 2f68a5c — Codex verify statis (G0o4n): 4 temuan tertutup, tidak ada regresi baru, lifecycle 12/12, kontrak 44/44. Tes integrasi terfokus BELUM jalan (kuota Codex habis): jalankan lewat subagent test-runner sebelum minta gerbang. `legend-dahl` ditutup saat merge.
- Urutan merge edge: `ws/edge-hardening` → legend-2lp.7 (registry pull) → `ws/device-registry`. Salah urut = semua token device edge ditolak.
- Saat merge: nomor migration 0063–0065 bentrok antar cabang, renumber per HANDOFF §5 (drizzle-kit, jangan edit `_journal.json` tangan). Merge lewat worktree sementara `.worktrees/main-merge`, `merge --no-ff`, gerbang penuh di main.

- 2026-11-08 malam (CTO G6ifq): tes integrasi `ws/pos-payment-fixes` 2f68a5c LULUS: `heavy pnpm test` API 1227 lulus/0 gagal (141 file), root 1384/0; fokus payment-lifecycle 12, qris-lifecycle 14, qris-round2 3, approval 9, deposit-lock 6, pos-order 13. Siap gerbang merge.
- Brief second-opinion Codex 59–63 ditulis (commit d376a5a).
- Refund approval `ws/refund-approval` 5b6a707 SELESAI (gerbang penuh hijau, 43 test). Second-opinion Codex brief 65; urutan antrean Codex: 59 shift, 65 refund, 68 struk putaran 2 (ws/pos-receipt e11caae), jurnal (ws/journals, brief menyusul), PPh21 putaran 2 (ws/payroll-pph21-tests a0bf212, brief menyusul), HRIS cuti (ws/hris-leave 576cb1e, brief menyusul), 60 EDC, 61 procurement, 62 DOIT, 63 KDS.
- Thread baru G1u8c legend-2lp.7 (brief 64): cabang `ws/edge-registry-pull` = edge-hardening + device-registry + tarik berkala; merge cabang ini menggantikan urutan merge edge 3 langkah.

- Struk `ws/pos-receipt` e11caae SELESAI putaran 2 (gerbang hijau). Thread UI kasir alur shift G0prp (brief 67, `ui/pos-kasir-shift`). Merge 5 cabang (brief 66) via subagent. Founder Q1 setuju UI kasir, Q2 Rp0 boleh + 1 konfirmasi, Q3 merge semua.

- Founder Q10: second opinion campuran. Codex: uang/auth/migration/data pribadi (59 shift, 65 refund, 68 struk, 70 jurnal, PPh21, 62 DOIT, 60 EDC). Architect Claude subagent: 63 KDS, 61 procurement, stok opname, cuti HRIS, SOP. Founder Q4 struk tanpa pajak boleh; Q5/Q6 jurnal; Q7 cuti bersama memotong saldo (per tenant).

- MERGE SELESAI: `main` = 1f0b6d2 (db-role 12f7fe3, fiscal e24813f, edge-hardening b765f1a, pos-payment-fixes fd1550f, ui/pos-kasir cbb03d4). Migration renumber: 0063_edge_received_events→0065, 0063_known_gladiator→0066, 0064_smiling_gravity→0067. Gerbang: vitest 1305, node 1414, build hijau. Belum: fresh-DB migrate + mock e2e (test-runner jalan). Tidak di-push. Bead ditutup: zoqc, 72we, wg5t, zinn, b0au, 94qt, 0gy1, dahl, mjmm.
- Architect second-opinion: procurement 2 Sedang (brief 73), stok opname 2 Tinggi (dikirim ke G8zyp), KDS 4 Sedang (brief 74).

### Thread berjalan
| Thread | Kerja | Cabang |
|---|---|---|
| G2737 | Struk putaran 2 (brief 55) | ws/pos-receipt |
| G70ms | PPh21 putaran 2 + config kebijakan pajak `legend-y4wp` (brief 54) | ws/payroll-pph21-tests |
| G3pew | Refund approval legend-hvvn + rbjw (brief 51) | — |
| G5klp | HRIS cuti legend-hggk (brief 53) | — |
| G8zyp | Stok opname legend-j5x (brief 57) | ws/stock-opname |
| G5psg | Jurnal manual/berulang legend-vmyg (brief 58) | ws/journals |

Uang/PPh21/refund/shift/struk: setelah lapor, perlu reviewer + architect + second-opinion Codex.

### Menunggu second-opinion Codex (kuota habis)
- PRIORITAS: POS shift `ws/pos-shift` 580d0db (putaran 2 selesai: 5 temuan + 2 temuan reviewer dibetulkan, check 1277 lulus, build hijau). Migration 0063–0067 di cabang ini. Kontrak berubah: close pakai `countId`, endpoint baru `.../shifts/:shiftId/counts`, tunai wajib shift terbuka (409 `SHIFT_NOT_OPEN`). Konflik merge diperkirakan dengan `ws/kds` dan `ws/pos-payment-fixes`. Ronde berikut ke agent baru (sesi G8pc7 compact 2x).
- UI POS kasir perlu menyusul: buka shift sebelum terima tunai; tutup shift 2 langkah (hitung, lalu tutup).
- Akun Codex 3 reset 23:36, akun 2 reset 00:24 (9 Nov). Cron 518b310d jam 23:40 (sesi lama; bila sesi lama mati, jadwalkan ulang): mulai maks 3 sekaligus.
- Antrean: EDC (ws/edc-framework 5f797fe), procurement (ws/procurement ae09d1d), DOIT (ws/doit-provider be35d6b), KDS (ws/kds 4a1f613), print agent (ws/print-agent cb385ab), device registry (7caa7be, B18), recipe/BOM (f0cec09, B19), tenant config export (1405f19, B20), AI tool catalog (78d516a+d15542a, B22). Brief second-opinion untuk tiap cabang belum ditulis (pola: brief 24/26/30/32).
- Cabang lain belum direview: ws/checklist-engine e3ac2ef, fix/worktree-shared 4ab45cc.

### Menunggu founder
- Gerbang merge: db-role, fiscal, edge-hardening (dan payment setelah tes integrasi).
- Review UI POS kasir (`ui/pos-kasir` 3f5c91e): page `scratchpad/pos-kasir-review.html` sesi lama, Q1 setuju/ubah, Q2 modal awal Rp0.
- DOIT sandbox: base URL, link docs, webhook secret. Key sandbox di `~/.config/legend/doit-sandbox-api-key`.
- Config PPh21: sementara ikut saran CTO, nanti disesuaikan konsultan (legend-y4wp).

### Biaya sesi CTO G4tde
Total ±11,58 juta token-biaya* (subagent Opus 1,31 jt, Sonnet 0,38 jt, Haiku 0,07 jt).

## Sudah
- Benchmark order pelanggan ESB + Richeese vs Legend: `design/benchmark/REPORT.md` (14 celah), `design/REFERENCES.md`. Cabang `ux/customer-order-benchmark`.
- Keputusan founder:
  - Q3: "Bayar di kasir" boleh (kode ke kasir, pesanan masuk dapur setelah kasir terima uang).
  - Q4: arah A (katalog foto).
  - Q5: jumlah tamu inline di bar atas menu, wajib sebelum item pertama, tanpa jendela sambutan.
  - Founder minta gaya liquid glass; menilai versi lama "AI slop dan jadul".
- Mockup final arah A + liquid glass: `design/mockups/final-a-*.png` (9 mobile + 1 desktop), README berisi usulan perubahan `DESIGN.md`. Commit `b52b03b`.
- legend-18qw (worker event transport, gap replay, adapter notifikasi Brevo): commit `b22d549` di `ws/worker-transport` (worktree `.worktrees/worker-transport`). pnpm check hijau. Bead sudah di-close engineer.
- Review legend-18qw: reviewer Claude (tanpa blocker) + second-opinion Codex (2 major). Semua temuan: `docs/briefs/06-fix-review-worker-transport.md`.

## Sedang
- (kosong selain thread di bawah)

## Sesi CTO baru (2026-11-08, lanjutan)
- SELESAI fix review legend-18qw (brief 07): `ws/worker-transport` = `262d012` (amend WIP). 9 fix + 3 temuan reviewer subagent dibetulkan. `heavy pnpm check` hijau (1192 test), build hijau, format/color/tenant-hardcode lulus. `legend-3a0y` ditutup. Bead baru: `legend-7h5s` (edge tanpa cloud-sync tenant-wide), `legend-z649` (healthcheck worker), `legend-k1np` P1 (cek backfill sequence sebelum deploy), `legend-j75w` P2 (alert terthrottle auth Brevo). Sisa risiko: dedup Brevo belum dites ke Brevo asli (tunggu `legend-wwuc`); at-least-once bila retry >30 menit. Biaya sesi engineer: ~933k (Opus 668k, Haiku 151k, Sonnet 114k).
- SELESAI riset warna (brief 08, Codex): `design/COLOR-RESEARCH.md`, 10 `final-a-*` ditimpa, palet CTA #A83A17 / canvas #FAF6F0 / tinta #2B211B, upsell croissant opsional, 87 pasangan kontras lolos AA. Commit `13606fe` (sebagian artefak ikut tersapu commit CTO `b76fc75`; riwayat dibiarkan). Dikirim ke founder sebagai Q3 (setuju / ubah).
- Founder Q2: merge disetujui. `main` = `b0695ba` (merge --no-ff `ws/worker-transport`, tree identik `262d012` yang sudah hijau). Cabang + worktree worker dihapus.
- Founder Q3: mockup warna baru DISETUJUI.
- Thread "UI order pelanggan QR" (brief 09, `legend-2re1`): worktree `.worktrees/customer-order-ui`, cabang `ui/customer-order` (ux/customer-order-benchmark + main).
- Thread "Provisioning role DB first boot" (brief 10, `legend-zoqc`): worktree `.worktrees/db-role-provisioning`, cabang `ws/db-role-provisioning` dari main. Review: reviewer Opus tanpa blocker; second-opinion Codex 5 Tinggi (override identitas via query URL pg, override env file Compose, pg_default_acl, grant per kolom, rahasia bocor di error Compose). Fix: brief 12, engineer sama.
- Founder: metode bayar web = QRIS, VA, E-wallet, Kartu kredit/debit (+ bayar di kasir); kasir = semua + EDC. Diteruskan ke thread UI.
- Founder: minta lebih banyak agent paralel. Mulai 3 engineer: legend-6c0 shift (`ws/pos-shift`, brief 13), legend-93a struk (`ws/pos-receipt`, brief 14), legend-zinn+wg5t edge (`ws/edge-hardening`, brief 15). Migration bisa bentrok nomor: merge berurutan, generate ulang di cabang belakangan.

- Mockup POS kasir 21 layar (`design/mockups/pos/`, commit `3e09560`, brief 17) DISETUJUI founder Q10. Q7 DP lebih jadi saldo; Q8 blind count per pecahan; Q9 tutup hari manajer outlet, cutoff 04.00. Diteruskan ke thread shift dan fix pembayaran.
- zoqc: second-opinion putaran 2 = 3 Tinggi + 2 Sedang baru (PUBLIC baseline katalog, BOM/NBSP env, RLS tabel tenant tak diaudit, sequence ACL, docs ganti login queue). Fix: brief 18.
- Berikutnya saat slot Claude kosong: ui-engineer POS kasir dari `design/mockups/pos/`, engineer KDS legend-4d5, engineer EDC legend-m0k.

## Keputusan founder Q6 (mockup final): UBAH DULU
- Catatan founder apa adanya: "Coba riset warna termasuk warna button secara psikologis yang mendorong pembelian serta membuat orang memesan banyak".
- Langkah: riset psikologi warna untuk F&B order (warna CTA/tombol, warna yang mendorong nafsu makan dan nilai pesanan lebih besar, bukti dari sumber kredibel, bedakan mitos vs bukti, tetap lolos kontras WCAG), tulis `design/COLOR-RESEARCH.md`, lalu designer (Codex) ulang `final-a-*` dengan palet baru, review founder lagi. Pola upsell/menambah pesanan (rekomendasi "tambah minuman", bundling) boleh diusulkan bersama.

## Langkah berikut
1. (selesai) fix brief 06.
2. (selesai, menunggu founder Q3) riset warna + ulang mockup.
3. Setelah mockup disetujui: ui-engineer bangun UI order pelanggan dari `final-a-*`, update `DESIGN.md` sesuai usulan README mockup. Jangan sentuh area worker.
4. Merge `ws/worker-transport` dan `ux/customer-order-benchmark` ke `main`: menunggu gerbang founder.
5. Penghalang rilis lain (HANDOFF.md §7): legend-zoqc, legend-91i (layar ke API asli), POS FE, dsb.

## Catatan teknis
- Coordinator Ghostex dijalankan di folder `legend super app` (bukan repo git): `start-thread --worktree` gagal. Buat worktree manual di `legend/.worktrees/<nama>` + `.claude/settings.local.json` pematik claude-mem, tulis path di brief.
- Brief tim: `docs/briefs/01..06`.

## Vendor (gelombang ini)
- Claude: benchmark, engineer, reviewer (3 tugas). Codex: designer (2 putaran), second-opinion (3 tugas).


## Serah terima kuota (22:45)
Akun Claude #1 habis (reset 23:09); CTO berhenti. Thread dipindah ke akun #2. Berjalan: G8x09 DOIT, G7cu9 EDC batch_no, G2tir PPh21 campuran, G5rd6 shift (ulang gate), G5klp cuti (brief 85), G9d1y struk (brief 77). Subagent: fix hris-sop (brief 86). Berikut: gate milestone setelah merge shareholder; merge journals → refund → hris-sop → edc → pph21 → shift → hris-leave (regen tiap cabang). Codex cron 23:41 & 00:27. Subagent merge-prep shareholder sempat menjalankan `pkill -f <id task>` (pelanggaran, cakupan sempit) — cek tidak ada test lain yang mati.
## Serah terima CTO 23:05 (sesi compact 2x)

- milestone/m1 head 8e2e7bc0 (reservasi masuk). Gerbang penuh belum dijalankan ulang setelah merge reservasi; cabang reservasi sendiri sudah hijau di atas 55d90ab3 (API 1527, root 1420). Jalankan `heavy pnpm check` di worktree milestone sebelum merge berikut.
- Merge-prep journals: subagent CTO lama sedang regen migration journals di atas head terbaru (0075+). Bila hasilnya hilang bersama sesi lama: ulang dari brief "Catatan merge milestone" di atas.
- DOIT `ws/doit-provider` 8fed84ef: fix review K selesai (G8x09 di-resolve). Migration cabang 0068/0069 bentrok dengan edge 0068/0069 di m1, wajib regen saat gilirannya. Full `pnpm check` belum diulang setelah fix migration terakhir (file terdampak 136/136 hijau). Belum diuji ke sandbox DOIT; cek apakah `~/.config/legend/doit-sandbox-api-key` ada (jangan cetak isinya).
- DOIT pertanyaan founder terbuka: transfer bank kode unik dimatikan (API DOIT tidak memberi rekening tujuan). Opsi: biarkan mati, atau perluas skema instruksi pembayaran (rekening tujuan, kode unik, fallback `hosted_url` saat QR kedaluwarsa ~10 menit).
- Thread jalan: G5rd6 pos-shift (gerbang 78a274a jalan), G7cu9 EDC (gerbang), G9d1y struk (brief 77), G7pk4 procurement (brief 73), G7wwc KDS (brief 74).
- Codex: cron d29dba1e 23:36 (R1, akun 3) dan 8763dcff 00:24 (R2, akun 2) ada di sesi CTO lama; cron sesi tidak ikut pindah, jadwalkan ulang di sesi baru. Brief R4 PPh21, R6–R9 belum ditulis.
- Jawaban founder "berapa task lagi": 440 kartu non-epic terbuka, 35 P0/P1 (7 P0 semua EXT pihak luar). Inti rilis: 10 cabang antrean merge, Codex R1–R9, jembatan inventori→GL (legend-w1vo), migrator role production (legend-jtnd, legend-k1np), e2e A–Z (legend-hmz2, legend-o2on), runbook (legend-71d), monitoring (legend-az9), review founder Q6 + Q12, akun production. Usulan ke founder: tetapkan daftar potong rilis (WS-12 AI, sebagian WS-09/WS-14 pascarilis).

### Keputusan founder 23:15
- Fitur kamar mandi / smart lock ditunda (legend-3dm8, legend-bzih, legend-2ke, legend-s20 → deferred). Rilis menyusul.
- Tidak ada transfer bank. Metode bayar: QRIS, virtual account, debit/kartu kredit, bayar di kasir (tunai, EDC). Transfer bank kode unik DOIT tetap mati; tidak perlu perluasan skema `hosted_url`. Cek apakah rail kartu (debit/CC online) DOIT sudah tercakup di `ws/doit-provider`.
- Fitur AI, Wi-Fi, ojol: founder belum menunda, anggap tetap dalam cakupan.

### Rekonsiliasi papan 23:25
- 8 kartu ditutup (kerja sudah di main/m1): sdet, xm30, 165, 2lp.7, meki, 69yq, o5gr, j5x.
- 26 kartu ditutup saat cabangnya digabung ke m1: ai-tool-catalog 1zxo 9v9t; pph21 oo3q y4wp iwgb 5cnk; refund rbjw hvvn; kds s2dh 4d5; procurement 25a7 9yz; hris-leave hggk arj.1 arj.3 arj.4; checklist 5v69; pos-shift 6c0; hris-sop 7df1; receipt 93a; doit b9i; recipe-bom db6; journals vmyg; config-export 34c; print-agent 46p; edc apt.
- Progres nyata ~43% (331 selesai, 435 tersisa). Terendah: WS-13 QA 8%, WS-12 AI 12%, WS-02 edge 23%.

### Keputusan founder 23:35 + perbaikan workflow
- AI, Wi-Fi, ojol tetap masuk rilis pertama.
- Diagnosis lambat: rata-rata ~1,6 subagent berjalan per agent (ram-guard: 11 subagent untuk 7 agent). Penyebab: brief per fix kecil (tak ada yang bisa diparalelkan), gate penuh diulang tiap langkah, merge serial dikerjakan CTO.
- Perubahan: (1) agent baru menerima workstream 5–15 kartu dengan `docs/briefs/_TEMPLATE-workstream.md` (fan-out wajib di giliran pertama, test-writer paralel implementer, gate penuh sekali); (2) merge train dipegang thread sendiri (brief 89), persiapan konflik paralel per cabang di worktree, hanya regen migration yang serial; (3) e2e/QA (WS-13, 8%) dimulai sekarang, tidak di akhir; (4) laporan agent wajib menyebut jumlah subagent dan puncak paralel, dicatat tiap gelombang.

### Insiden 00:10 (9 Nov)
- gxserver mati ~23:55, dinyalakan ulang CTO (`gx server start`). Colima "not running" sementara VM masih hidup: port container baru tidak diteruskan, semua test DB gagal "PostgreSQL is not reachable". Subagent CTO sedang memulihkan.
- macOS menolak membuka terminal baru dari login ini ("macOS refused to start it from this login"): 3 thread gagal start (G58ni Codex refund, G0c95 WS-02 brief 90, G30x7 WS-13 brief 91). Butuh founder restart Ghostex / logout-login. Setelah itu: reopen/start ulang ketiganya.
- Git identity global hilang setelah pindah akun; diset lokal di repo (`git config user.name/email`).
- Thread G5rd6, G9d1y, G7wwc, G7pk4, G7rxu di-resolve: kode di-commit, gate penuh mereka diserahkan ke merge train (G5dhx). SHA: pos-shift 6c1ec83, struk 1657797e, kds 9ee5a885, deploy-prep 3e2f516e, procurement HEAD ws/procurement.
- Codex: brief 65 refund SHA 09385266 siap; struk diff 87c27ed7..1657797e; deploy-prep milestone/m1..ws/deploy-prep (perlu brief). Cron akun 2 00:25 di sesi CTO ini.
- 00:20 Jembatan inventori→GL (G9c40, tetap terbuka): ws/inventory-gl 2253c281, migration 0075/0076 (bentrok journals 0075/0076 → regen saat merge). Kode, build, lint hijau; test DB belum jalan (opendirectoryd). Saat DB pulih: kirim pesan ke G9c40 untuk `LEGEND_TEST_FILES="src/test/inventory-gl.test.ts" heavy node scripts/test.mjs unit` + `heavy pnpm check`. K: perlu Codex.
- 00:20 Semua akun Claude di Ghostex "needs sign-in" (keychain tidak terbaca, opendirectoryd rusak). Merge train G5dhx berhenti "Login expired". Founder diminta: `sudo launchctl kickstart -k system/com.apple.opendirectoryd` atau restart Mac, lalu login ulang akun #1–#3.

### Pulih 05:30 (9 Nov)
- Founder restart Mac. whoami normal, akun Claude/Codex ready, Colima + port forward OK (probe 55432).
- G5dhx merge train dan G9c40 inventori→GL dilanjutkan (DB pulih). G0c95 (brief 90) dan G30x7 (brief 91) di-reload lalu dikirimi brief. Codex refund berjalan di G7110 (akun 2, xhigh). G58ni = sesi Codex kosong sisa crash, abaikan/resolve.
- Akar insiden: tekanan memori (8 thread + ~16 subagent menjalankan gate penuh bersamaan, swap 7 GB, 13 container DB test basi) → opendirectoryd macOS rusak setelah uptime 5 hari → user 501 tak dikenali → terminal baru ditolak, login akun tak terbaca, Colima/ssh gagal, gxserver mati.
- Pencegahan: gate penuh sekali per tugas (sudah di TEAM.md), cleanup container test otomatis (bd baru), restart Mac mingguan, CTO cek `docker ps | grep -c starter-pg-test` tiap gelombang.
- 05:55 inventori→GL SELESAI (G9c40): ws/inventory-gl bf5c895f, test 18/18, gate penuh hijau 1545. Masuk antrean merge train (migration 0075/0076 → regen). DIGABUNG m1 `982c2e0a` (prep 296ec728, migration diregen 0086/0087; gate prep hijau API 2165 / root 1426; kartu w1vo ditutup). Codex R10 inventory-gl (xhigh). Lanjutan legend-s4r6 (applier stock.moved edge→cloud, ke G0c95) dan legend-9w46 (HPP ke recipe-bom setelah db6 digabung).
- 06:00 RAM kuning (batas 4 thread, aktif 7): thread baru ditahan. Antre start: fix DOIT brief 95 (reopen G8x09), WS-03 brief 94 (belum ditulis ulang).
- 06:40 Fix refund temuan Codex SELESAI (G0fvq): ws/refund-approval 7c24b7b8. Temuan 1 sesuai PRD :541/D14 (refund wajib supervisor: jalur langsung butuh pos.refund.approve). Temuan 2: payout evidence ambigu ditahan EVIDENCE_MAPPING_REQUIRED + unique index (migration 0069 → regen). Test 73/73 sebelum guard terakhir; gate penuh diserahkan ke merge train. 12 subagent, puncak 5. Codex R2b atas diff fix (brief 65 SHA 7c24b7b8) di jendela kuota berikut.
- Target maksimal 6 thread Claude sekaligus (RAM merah 2x dalam 7 jam).
- 07:00 WS-13 e2e A–Z (G30x7 selesai): ws/e2e-az 3bf9e8d1, 57 lulus / 64 skip (menunggu cabang) / 0 gagal. Laporan docs/qa/2026-11-09-e2e-az.md. Bug P1: legend-vj37 (build produksi crash, sharp dibundel tsup), legend-ozud + legend-ww29 (whitelabel bocor). Fix lewat subagent CTO di ws/fix-sharp dan ws/fix-whitelabel. 18 subagent, puncak ~8.
- Keputusan tim: EDC-04 approval aksi `edc_standalone`, wajib PIN supervisor.
- DOIT tidak punya rail kartu (rail: qris, va, transfer, any; docs doit.id/docs/en). Kartu online butuh keputusan founder: tunda (kartu hanya EDC di kasir) atau Duitku sekarang. PRD baris 223/257/680/1754 perlu dirapikan (transfer bank dihapus) setelah jawaban itu.
- DOIT G8x09 selesai: 96df32a8 + PROGRESS 6b5c67c0, sisa temuan legend-3wpf (P2).
- 07:10 WS-11 laporan (G2lso selesai): ws/ws11-reports 53e6b484, 11 kartu ditutup, 21 subagent (puncak 7). Tanpa migrasi. Gate penuh → merge train. Codex R11: 981abe32 (metrik GL + akses shareholder, ~800 baris, high). legend-5bjh: rute laporan agregat sendiri di area shareholder (keputusan CTO).

### Merge train 89 (lanjutan, 09-11)
- m1 `982c2e0a` inventory-gl (0086/0087, gate API 2165 / root 1426, w1vo ditutup).
- m1 `b49202b5` prettier 2 file refund (format:check tidak termasuk `pnpm check`; kini dijalankan per merge).
- m1 `f77e18d8` deploy-prep (tanpa migration; gate prep 97f008cc API 2177 / root 1427 termasuk legend-zoqc DB; jtnd k1np ditutup).
- Rantai dibangun ulang (brief 89c): fix-sharp → pos-shift (0088-0090) → refund fix (0091) → procurement → kds → doit → e2e-az → ws11-reports → fix-whitelabel → struk (cherry-pick 85723463).
- 07:50 WS-02 edge (G0c95 selesai): ws/ws02-edge 756b45ae, 7 kartu ditutup, 21 subagent (puncak 8). Migration 0079/0080 → regen (FK edge_sync_conflict_resolutions tetap di CREATE TABLE). Codex R12 (auth rotasi/lockout + migrasi + stok→GL, high). m1 sudah di 0085.
- Fix produksi: ws/fix-sharp 9761605c (docker runner terverifikasi), ws/fix-whitelabel 47bcf9c1; AUTH-06 sedang (subagent CTO, ws/fix-auth06).
- Brief 98 WS-01 menunggu slot.
- m1 `71751c8f` fix-sharp (legend-vj37, prioritas: build produksi crash). Gate prep b2eef70a API 2177 / root 1427 + build API tsup sukses; format:check bersih; vj37 ditutup.
- m1 `30a31a3c` pos-shift (0088-0090; fix ULID legend-xvyr + nama migration pos-day; 6c0 xvyr ditutup).
- Keputusan founder (9 Nov pagi): rilis TANPA kartu online. Online: QRIS + VA (DOIT). Kasir: tunai, EDC (debit/kredit), QRIS. Kartu online menyusul via Duitku pascarilis. PRD dirapikan (subagent doc-writer).
- m1 `baf6d615` fix refund Codex R2 (brief 92; 0091 partial unique index fund evidence; gate API 2301 / root 1427).
- m1 `b8fed67b` fix-auth06 (AUTH-06 redirect ke appHomePath; tanpa migration; gate prep 6c213190 API 2301 / root 1427; e2e auth/roles hijau di cabang menurut CTO, tidak diulang di m1).
- m1 `9f446f9b` procurement (0092/0093; NO FORCE outlets/inventory_items/uoms; gate prep a94ea4f3 API 2379 / root 1432; 25a7 9yz ditutup; brief 61 rentang b8fed67b..9f446f9b).
- m1 `5c04f1b2` kds (0094-0096; gate prep 07130a4e API 2447 / root 1432; s2dh 4d5 ditutup; brief 63 rentang 9f446f9b..5c04f1b2).
- m1 `13425b65` doit-provider (96df32a8 + fix Codex brief 95; 0097/0098; gate prep 1836c2f4 API 2777 / root 1432; b9i ditutup; brief 62 rentang 5c04f1b2..13425b65).
- m1 `1e2ab930` cherry-pick PRD d6a223d9 (metode bayar: tanpa transfer bank, kartu online Duitku pascarilis; docs/PRD.md saja).
- Rantai 3 (tanpa head-of-line blocking): ws11 gagal tripwire audit inventory-count (reopen G8kmx), jadi ws02 → whitelabel → receipt dibangun langsung di atas m1; gate paralel di heavy (adaptif 4 jalur).
- m1 `e8efc11d` ws02-edge (fix tes training 9f1c40af dari G0h5c; 0099/0100; gate prep3 5cb07d8d API 2885 / root 1433; 7 kartu sudah ditutup thread asal; brief 108 rentang 1e2ab930..e8efc11d).
- m1 `cc3e778c` fix-whitelabel (TEN-08 manifest + design-system nama tenant; tanpa migrasi; gate prep4 2d0f7f4a API 2885 / root 1437; ozud ww29 ditutup).
- m1 `726515a4` pos-receipt (fix 85723463 SHIFT_NOT_OPEN; 0101/0102 + NO FORCE outlets/pos_orders; gate prep2 39296fae API 2975 + 1 flaky pos-shift:741 urutan event, lulus 62/62 saat diulang, kartu legend-t8xt; 93a ditutup; brief 68 rentang cc3e778c..726515a4).
- m1 `fb46602d` ai-tool-catalog (kontrak katalog AI/MCP; tanpa migrasi; gate prep 75355db7 API 2974 + 2 kds-realtime gagal karena beban 4 gate paralel, file lulus 20/20 sendiri; 1zxo 9v9t ditutup).
- Temuan: gate receipt dan catalog berhenti di vitest sehingga suite root tidak jalan; m1 726515a4/fb46602d gagal root 'every typed mock response passes its contract schema' (mock ws04 receiptIssueWire tanpa `reprint`, kontrak dari 6ea544f9). Fix di m1 `031a4621`. Aturan baru: merge hanya bila baris `ℹ tests/pass/fail` root ada di log gate.
- m1 `97702627` fix-codex-kds (per-line moves saat ticket start, readyAt dihapus saat recall; gate prep 074d734e API 2886 / root 1437; re-check di atas fb46602d 130/130 + tsc). Gate penuh m1 di 97702627 sedang jalan.
- m1 `dab1d592` fix-doit-webhook (P1 uang: payload webhook DOIT tersimpan diproses, signer asing ditolak; tanpa migrasi). Gate prep f336a85c API 2983 / root 1437 + 1 gagal mock warisan (sudah dibetulkan m1 031a4621); prep di atas 97702627: test webhook/supersede 108/108, mock contract 9/9, format bersih. Diff `97702627..dab1d592`. Tidak ada kartu bd khusus DOIT webhook (dicek `bd list`).
- Aturan baru CTO (09-11): maks 2 `pnpm check` sekaligus; gate batch lewat `integ/m1-batchN` dari m1 (merge --no-ff berurutan, satu `pnpm check`, lulus: fast-forward m1; gagal: bisect per cabang). Gate per cabang yang sedang jalan dibiarkan selesai, tidak ada gate per cabang baru. Beban CPU tinggi membuat kds-realtime gagal palsu.
- Serah terima (sesi merge train sudah compact 2x). Gate yang masih jalan, log di scratchpad sesi 08f54ec9 (`gate-<x>.log`): EDC prep 3fbfe167 (`gate-edc.log`), refund f175836b (`gate-cxrefund.log`), journals-expiry f4b06b99 (`gate-jexp.log`, format:check gagal 4 file, perlu prettier), testdb-cleanup efed33f2 (`gate-testdb.log`), m1 97702627 (`gate-m1.log`). Prep tanpa mock fix 031a4621 akan gagal 1 test root warisan.
- Prep siap untuk batch1 (setelah gate di atas): EDC `prep/fix-edc-codex` 3fbfe167 (merge asli; backup `backup/prep-fix-edc-codex-squash`), refund `prep/fix-codex-refund` f175836b, journals-expiry `prep/fix-journals-expiry` f4b06b99, testdb-cleanup `prep/testdb-cleanup` efed33f2, ws-09-ws `prep/ws-09-ws` 6df2d858, po-pdf-font (prep subagent selesai, cek cabang `prep/fix-po-pdf-font`), baru: ws/fix-m007-fk-rls 19640b63 (FK WS-10 ke tabel FORCE RLS, pemilik S30:P9mkl:G2m4p).
- Sesudah EDC masuk m1: regen wifi `prep/ws09-wifi` 76121e6a ke 0105/0106, hardening `prep/ws09-wifi-hardening` 3d87bf54 ke 0107/0108; buka skip e2e EDC-01/02/04 di prep/e2e-az. Regen berurutan sesudahnya: ws12-ai `prep/ws12-ai` 680d9649, ws03-menu `prep/ws03-menu` 3ac603ce, ws08-site, fix-codex-procurement, fix-codex-shift, checklist-schedule. Tertahan: ws11 `prep3/ws11-reports` ae5ed5c1 (tripwire audit, G8kmx), e2e-az `prep/e2e-az` c9110ef1 (fixture, G4k8i). Rincian pemilik dan mekanik: `docs/briefs/89c-chain-rebuild.md`, `89a-merge-prep.md`.
