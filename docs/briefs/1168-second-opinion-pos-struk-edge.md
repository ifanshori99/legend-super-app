# 1168 Second opinion POS struk + edge re-apply (ws/1162)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff milestone/m1...f9586c0db` (cabang origin/ws/1162-pos-struk-edge; abaikan commit sesudah f9586c0db). Konteks: `docs/qa/second-opinion-pos-edge-1111.md`.
Isi: legend-gdjpu, sweep `edge-order-redrive.job.ts` menerapkan ulang receipt run yang ditolak sesudah void/sale pulih (transaksi per run sesudah void commit, error ditangkap, konflik dengan resolusi supervisor dilewati, jalur paid-recovery ikut). legend-j772n, bucket DP `depositAppliedIdr` di kontrak struk/invoice (`packages/shared/src/pos/schemas.ts` checkDocumentTotals; tender + DP = total, DP > total ditolak, DP-only tanpa tender), baris "Uang muka (DP)" di PDF dan cetak edge, DP bukan tunai dan tanpa kembalian.
Cari: nomor struk ganda/lompat, pembalikan ganda, void yang bisa ter-rollback, re-apply yang menulis ulang data lintas tenant/outlet, DP terhitung dua kali di total/kas/rekap, kembalian dari DP, dokumen tidak seimbang yang lolos.
Hasil: tulis `docs/qa/second-opinion-pos-struk-edge-1168.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
