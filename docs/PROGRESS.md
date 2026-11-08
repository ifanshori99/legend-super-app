# PROGRESS — Legend Super App

Diperbarui 2026-11-08 oleh CTO (coordinator Ghostex, sesi "CTO legend"). Founder menghentikan semua kerja untuk dilanjutkan di sesi baru.

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

## Sedang (dihentikan di tengah)
- Fix temuan review legend-18qw: commit WIP `5a6070d` di `ws/worker-transport`, BELUM selesai dan BELUM dites. Lanjutkan dari brief 06, lalu `heavy pnpm check`, reviewer cek diff fix.

## Menunggu founder
- Q6: setujui mockup final (`design/mockups/final-a-*`) untuk dibangun, atau ubah dulu. Halaman review dibuat dari gambar itu.

## Langkah berikut
1. Engineer lanjutkan fix brief 06 di `ws/worker-transport` (agent baru: Opus high, brief 03 + 06).
2. Setelah Q6 disetujui: ui-engineer bangun UI order pelanggan dari `final-a-*`, update `DESIGN.md` sesuai usulan README mockup. Jangan sentuh area worker.
3. Merge `ws/worker-transport` dan `ux/customer-order-benchmark` ke `main`: menunggu gerbang founder.
4. Penghalang rilis lain (HANDOFF.md §7): legend-zoqc, legend-91i (layar ke API asli), POS FE, dsb.

## Catatan teknis
- Coordinator Ghostex dijalankan di folder `legend super app` (bukan repo git): `start-thread --worktree` gagal. Buat worktree manual di `legend/.worktrees/<nama>` + `.claude/settings.local.json` pematik claude-mem, tulis path di brief.
- Brief tim: `docs/briefs/01..06`.

## Vendor (gelombang ini)
- Claude: benchmark, engineer, reviewer (3 tugas). Codex: designer (2 putaran), second-opinion (3 tugas).
