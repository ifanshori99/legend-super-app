# Brief: engineer — auto-journal slice 4 (settlement + MDR) lalu slice 3

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Slice 4: worktree `.worktrees/aj-settlement`, cabang `ws/aj-settlement` (dari b714f7b6, HEAD 93dd51a9, `worktree:setup` sudah). Slice 3: cabang dan worktree baru dari `milestone/m1` terbaru. Jangan checkout di folder utama (cabang `ux/customer-order-benchmark` milik kerja lain).

## Tujuan
Selesaikan legend-9pz9 slice 4 (jurnal otomatis settlement gateway dan EDC, termasuk biaya MDR), lalu slice 3 (order.paid dari jalur QR, `orderRevenueSplit()` bersama, fbms desain A). Satu slice selesai penuh (gate + review K + brief Codex) sebelum slice berikut.

## Langkah 0 (dulu, sebelum slice 4): temuan Codex 142
Second opinion Codex untuk slice 1-2 menemukan 4 temuan High di `accounting-auto-journal-amounts.ts`: `docs/briefs/142-second-opinion-auto-journals.result.md` (baca utuh). Ringkas: payout men-debit customer_deposit tanpa receipt yang terposting (:529); void penjualan selesai tidak membalik jurnal penjualan (:45); guard payout mengabaikan DP hangus (:548); guard DP bergantung pada urutan pengiriman event (:535, :603).
- Reproduksi tiap temuan dengan test dulu (jalur DB), lalu perbaiki. Desain perbaikan diputuskan bersama subagent architect (tingkat K).
- Cabang `ws/aj-fix142` dari ujung `ws/dp-late-journal` (cabang itu sudah masuk antrean merge train batch7; jangan ubah cabang itu sendiri). Worktree baru, `worktree:setup`.
- Bila perbaikan DP hangus butuh perubahan di `payment-admin.service.ts` (batas refund) atau modul refund lain: jangan ubah, tulis usulan di laporan; CTO yang mengatur dengan thread refund.
- Gate dan review K sama seperti slice. Brief Codex lanjutan: `docs/briefs/142b-...md` (hanya diff perbaikan).
- Selesai langkah 0: lapor (SHA, bukti, sisa), lalu tunggu CTO sebelum lanjut slice 4. Setelah itu gabungkan `ws/aj-fix142` ke `ws/aj-settlement` sebelum menulis kode slice 4.

## Kartu
`legend-9pz9` (slice 3 juga menutup `legend-kej3` dan `legend-fbms`). Di awal: `ghostex board associate legend-9pz9` dan `bd update legend-9pz9 --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- Serah terima lengkap (scope, fakta file:baris, gate, daftar jangan disentuh): `.worktrees/aj-settlement/docs/PROGRESS.md` bagian "Serah terima slice 4 dan 3". Baca itu dulu; brief ini tidak mengulanginya.
- Desain: `docs/design/auto-journals.md` (§8 diperbarui di slice 4).
- Emitter settlement milik bead lain (legend-3a5m, legend-jlqi, legend-cs7): jangan dikerjakan, jangan buat bead baru.

## Scope
- Boleh diubah: sesuai serah terima (schema event shared, `accounting-auto-journal-amounts.ts`, consumer auto-journal, `order-revenue.ts`, `qr-order-consumers.ts` untuk slice 3, test terkait, dokumen desain).
- Jangan disentuh: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, adapter/webhook DOIT, modul refund, `crm-promo-refund.ts`, approval policies.

## Bukti selesai (per slice)
- Gate dari serah terima: `LEGEND_TEST_FILES` berisi daftar eksplisit `src/test/...` (dibuat dengan bash nullglob dari root worktree); laporkan jumlah file yang benar-benar jalan dan jumlah lulus/gagal. tsc api/shared/web lewat `heavy`, eslint, prettier, kontrak node (`^ℹ pass`).
- Review K: subagent reviewer Opus + architect paralel; semua temuan nyata dibetulkan.
- Brief Codex per slice di `docs/briefs/163-...md` dan `164-...md` (tidak di-commit, maks 800 baris non-test, tanpa temuan Claude).

## Sebelum melapor
Commit lokal di cabang kerja tiap slice, termasuk `docs/PROGRESS.md` di worktree. Pesan commit merujuk legend-9pz9. Jangan push, jangan merge.

## Laporan
Setelah langkah 0: lapor dan tunggu. Slice 4 dan 3: lapor sekali setelah keduanya selesai, kecuali ada keputusan yang butuh CTO (lapor dan tunggu). Isi: hasil per slice, bukti (perintah, jumlah file test yang jalan, hasil), file berubah, commit SHA, risiko tersisa, nomor brief Codex, yang dibutuhkan dari CTO. Sesi compact 2x: tulis serah terima di PROGRESS worktree lalu lapor.
