# Brief: ui-engineer — POS kasir dari mockup yang disetujui

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Aturan UI: `~/.agents/team/ui-standard.md`. Konvensi: `AGENTS.md`, `DESIGN.md`, `docs/frontend.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-kasir-ui`, cabang `ui/pos-kasir` (mockup + `main` terbaru). Jangan pindah cabang.

## Tujuan
Bangun layar POS kasir (tablet landscape 1280x800 utama) sesuai 21 mockup yang disetujui founder (Q10, 8 Nov 2026): pembayaran QRIS, Virtual Account, E-wallet, Kartu, Tunai, EDC (nominal terkunci, menunggu, status tak pasti lalu cek status sebelum ulang, standalone dengan PIN supervisor), split tender, DP reservasi, kode "Bayar di kasir" dari pelanggan QR, shift kasir (buka, aktif, blind count per pecahan), persetujuan supervisor, tutup harian.

## Kartu
`legend-mjmm`. Di awal: `ghostex board associate legend-mjmm` dan `bd update legend-mjmm --status in_progress`. Saat melapor: `bd update legend-mjmm --status review` dan `bd comment legend-mjmm "<ringkasan bahasa biasa>"`.

## Masukan
- Mockup: `design/mockups/pos/*.png` + `design/mockups/pos/README.md` (daftar layar, keputusan Q7-Q9: DP lebih jadi saldo; blind count per pecahan; tutup hari oleh manajer outlet, batas 04.00). Baca gambar satu per satu saat membangun layar itu.
- Layar POS yang ada: `apps/web/src/routes/_ops/pos.*.tsx` dan feature terkait.
- Backend paralel (cabang lain, belum merge): shift `legend-6c0`, nomor struk `legend-93a`, fix pembayaran `legend-b0au/94qt/0gy1`, EDC `legend-m0k` (belum mulai). Pakai kontrak di `packages/shared` yang ada + mock (`VITE_API_MOCK=true`). Kontrak belum ada: tampilkan sesuai mock di balik mode demo seperti pola UI order pelanggan (`apps/web/src/features/ws03-qr-order/`), dan tulis kebutuhan kontrak di laporan.

- Kontrak POS berubah di cabang `ws/pos-payment-fixes` (belum merge): body void, refund, diskon memakai `overrideId` (id persetujuan supervisor dari server, sekali pakai, 15 menit), bukan `approvalRequestId`. Pakai `overrideId` di UI.

## Scope
- Boleh diubah: `apps/web/src/routes/_ops/pos*`, feature/komponen web POS, i18n pesan POS, e2e mock POS terkait.
- Jangan disentuh: `apps/api/`, skema/validator `packages/shared` (kecuali file pesan i18n), `_customer/`, `design/`.
- Dev server: port 3103 (maks 2 dev server di Mac).

## Bukti selesai
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus.
- Mock e2e POS lulus (lewat subagent test-runner, `heavy`).
- Screenshot 1280x800 tiap layar di `docs/qa/pos-kasir/`, dibandingkan sendiri dengan mockup. Subagent `ui-auditor` tanpa temuan berat.

## Sebelum melapor
Commit lokal di `ui/pos-kasir`, pesan merujuk `legend-mjmm`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, path screenshot, file berubah, commit, perbedaan disengaja dengan mockup, kebutuhan kontrak/API, risiko.
