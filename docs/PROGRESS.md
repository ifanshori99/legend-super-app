# PROGRESS — Legend Super App

Diperbarui 2026-11-08 ±19:50 oleh CTO (sesi G4tde "CTO baru"), serah terima ke CTO berikutnya.

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
- Refund approval `ws/refund-approval` 5b6a707 SELESAI (gerbang penuh hijau, 43 test). Second-opinion Codex brief 65; urutan antrean Codex: 59 shift, 65 refund, 68 struk putaran 2 (ws/pos-receipt e11caae), jurnal (ws/journals, brief menyusul), 60 EDC, 61 procurement, 62 DOIT, 63 KDS.
- Thread baru G1u8c legend-2lp.7 (brief 64): cabang `ws/edge-registry-pull` = edge-hardening + device-registry + tarik berkala; merge cabang ini menggantikan urutan merge edge 3 langkah.

- Struk `ws/pos-receipt` e11caae SELESAI putaran 2 (gerbang hijau). Thread UI kasir alur shift G0prp (brief 67, `ui/pos-kasir-shift`). Merge 5 cabang (brief 66) via subagent. Founder Q1 setuju UI kasir, Q2 Rp0 boleh + 1 konfirmasi, Q3 merge semua.

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
