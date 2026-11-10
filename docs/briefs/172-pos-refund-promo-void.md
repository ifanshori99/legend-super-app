# Brief: engineer — refund promo dan void POS non-tunai (legend-a0i7, legend-ioyg)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/pos-refund-void` dari ujung `milestone/m1` terbaru, worktree `.worktrees/pos-refund-void`, `worktree:setup`. Jangan checkout di folder utama.

## Tujuan
1. `legend-a0i7` (P1, tingkat K): total refund promo tidak boleh bergantung cara retur dibagi; sisa kewajiban tidak boleh terkunci. Detail dan reproduksi: `docs/briefs/127-second-opinion-refund-promo.result.md` (dua P1).
2. `legend-ioyg` (P1, tingkat K): void penjualan selesai di `pos-order-corrections.ts` hanya mengembalikan tunai. Void yang memakai gateway, EDC, atau poin: tolak (seperti void DP) atau kembalikan uangnya lewat jalur refund yang ada. Pilih bersama subagent architect; tolak lebih aman bila jalur refund belum siap. Auto-journal saat ini memarkir `AUTO_JOURNAL_VOID_UNSUPPORTED`; jangan ubah auto-journal, cukup cegah di sumber.

## Kartu
`ghostex board associate legend-a0i7`, `ghostex board associate legend-ioyg`, `bd update <id> --status in_progress`. Saat lapor: `--status review` dan `bd comment` bahasa biasa.

## Scope
- Boleh: `crm-promo-refund.ts`, `pos-order-corrections.ts`, modul refund bila perlu untuk void non-tunai, test terkait.
- Jangan: auto-journal (consumer/amounts), `pos-shift.service.ts`, `completePosOrder` dan kunci intent di `pos-order.service.ts` (cabang lain baru mengubahnya), `qr-order.service.ts`, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, adapter DOIT.

## Bukti selesai
Test reproduksi gagal dulu (dua P1 Codex 127, void gateway/EDC/poin). `LEGEND_TEST_FILES` daftar eksplisit (`src/test/*refund*`, `*promo*`, `pos-order*`, dibuat dengan bash nullglob, jalankan lewat `bash -c`); laporkan jumlah file jalan. tsc api/shared lewat `heavy`, eslint, prettier, kontrak node. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/172b-second-opinion-pos-refund-void.md` (tidak di-commit, tanpa temuan Claude).

## Laporan
Sekali setelah kedua kartu selesai: hasil, contoh angka Rupiah, bukti, file berubah, SHA, risiko, kebutuhan dari CTO. Commit lokal, jangan push, jangan merge.
