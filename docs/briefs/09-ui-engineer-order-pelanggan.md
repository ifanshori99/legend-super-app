# Brief: ui-engineer — order pelanggan QR dari mockup final arah A

## Peran

Baca `~/.agents/team/roles/ui-engineer.md` dan `~/.agents/team/TEAM.md` (bagian kerja berat dan definisi selesai), lalu ikuti. Aturan UI: `~/.agents/team/ui-standard.md`. Konvensi repo: `AGENTS.md`, `DESIGN.md`, `docs/frontend.md`.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/customer-order-ui`, cabang `ui/customer-order` (sudah berisi `main` terbaru + mockup). Jangan pindah cabang.

## Tujuan

Bangun ulang alur order pelanggan via QR meja supaya sama dengan mockup yang sudah disetujui founder (Q3, 8 Nov 2026): arah A katalog foto, liquid glass, palet baru Q6, saran pendamping opsional.

## Kartu

`legend-2re1`. Di awal: `ghostex board associate legend-2re1` dan `bd update legend-2re1 --status in_progress`. Saat melapor: `bd update legend-2re1 --status review` dan `bd comment legend-2re1 "<ringkasan bahasa biasa>"`.

## Masukan

- Mockup (sumber kebenaran visual): `design/mockups/final-a-*.png` (10 layar), sumber HTML/CSS `design/mockups/final-a-mobile.html`, `final-a-mobile.css`, `final-a-desktop.html`. Baca gambar satu per satu saat membangun layar itu.
- Aturan dan token: `design/mockups/README.md` (bagian "Final arah A + liquid glass", "Revisi warna (Q6)", "Usulan perubahan DESIGN.md"), `design/COLOR-RESEARCH.md`.
- Keputusan founder: Q3 "Bayar di kasir" (kode ke kasir, pesanan masuk dapur setelah kasir terima uang); Q5 jumlah tamu inline di bar atas menu, wajib sebelum item pertama, tanpa jendela sambutan; kaca hanya pada elemen mengambang.
- Layar yang ada: `apps/web/src/routes/_customer/t.$token*.tsx` (menu, cart, checkout, pay, orders, bill) dan komponen/feature terkait.

## Scope

- Boleh diubah: `apps/web/src/routes/_customer/t.$token*`, komponen/feature web untuk order pelanggan, token CSS tema pelanggan di `apps/web/src/styles/`, `DESIGN.md` (hanya menambah aturan tema QR pelanggan sesuai usulan README; jangan ubah warna POS/KDS/manajemen), e2e mock order pelanggan yang selector-nya berubah.
- Jangan disentuh: `apps/api/`, `packages/shared/` (kontrak), area worker, layar staf/owner. Butuh field API baru (misal data pendamping)? Jangan ubah kontrak: pakai data menu yang sudah ada (misal item kategori lain) dan tulis kebutuhan kontraknya di laporan.
- Dev server: `PORT`/`WEB_URL` di 3101 (maks 2 dev server di Mac). Mock mode: `VITE_API_MOCK=true`.

## Bukti selesai

- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus.
- Mock e2e yang menyentuh `/t/` lulus (lewat subagent test-runner, dengan `heavy`).
- Screenshot mobile 390 dan desktop 1440 tiap layar, disimpan di `docs/qa/customer-order/`, dibandingkan sendiri dengan mockup. Subagent `ui-auditor` lolos tanpa temuan berat.
- Fallback: `prefers-reduced-transparency` dan kontras tinggi jadi solid; `prefers-reduced-motion` dihormati.

## Sebelum melapor

Commit lokal di `ui/customer-order`, hanya file dalam scope. Pesan commit merujuk `legend-2re1`. Jangan push, jangan merge.

## Laporan

Hasil, bukti (perintah dan hasilnya), path screenshot, file berubah, commit, perbedaan dengan mockup yang disengaja, kebutuhan kontrak/API, risiko tersisa.
