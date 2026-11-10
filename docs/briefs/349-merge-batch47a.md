# Merge train batch47a (non-HRIS) ke milestone/m1

Peran: merge train (baca berkas peran engineer dan "Paralel dulu" di TEAM.md). Tidak mereview ulang isi cabang.
Basis: `git worktree add .worktrees/merge-batch47a -b ws/merge-batch47a milestone/m1` (29ddcbf7). Jangan checkout folder utama.
Remote: origin GitHub privat. Push `ws/merge-batch47a` dan `milestone/m1` setelah gate hijau. Jangan push `main`, jangan `--force`.

## Cabang (urutan merge, `--no-ff`; lewati tip yang sudah ancestor tip lain, cek `git merge-base --is-ancestor`)
1. ws/profit-share 9e3d3928
2. ws/8s992-profit-rules 0033ea1d
3. ws/lzvh0-unabsorbed-carry 6d75e50f
4. ws/0w2wy-docs-storage 80f5c4d1
5. ws/94q2l-impl b78f169c
6. ws/n6fek-recovery-refund-metrics ea9c7741
7. ws/k2l-followup f7bd22da
8. ws/dn4-wa-replies bd9e61a3
9. ws/mz15j-paid-check b5c67322
10. ws/nzbi8-swap-stock-park b594aab3
11. ws/oeqme-wifi-queue 52c7c7ef
12. ws/ideif-edge-pepper 3150feeb
13. ws/eirhm-menu-print-cleanup 8463d89a
14. ws/5tmye-whitelabel-flaky f4a782b7

## Fase 2: rantai HRIS edge (gate penuh sekali di akhir, setelah fase 1 dan 2)
15. ws/hris-edge-design 0148be9d
16. cku1m 462b2cbb, ye4j1 35bf1300, hwn02 092643e6 (cek nama cabang dengan `git branch --points-at`)
17. ws/tkycp-people-pull d244add8
18. ws/hubzo-selfie-worker 68704269 (memuat we0yc dan 0wvoz 8fa3f787)
19. Bila CTO mengirim tip baru (j6cyb, svy91, i83ls) sebelum gate mulai: ikutkan.

Tidak ikut: u37u3 (menunggu review founder).

## Migrasi
- Nomor sementara (0219-0229) dinomori ulang rapat mulai 0217, urut merge, `when` naik. Rename SQL, snapshot, tag jurnal; sambung ulang `prevId`; `db:generate` kosong sesudah tiap merge. Ganti rujukan nomor lama di kode/komentar/docs.
- 94q2l-impl mengubah berkas failed_item_recovery lama (kini 0212 di m1). Cek dulu apakah m1 pernah diterapkan ke DB bersama (staging/production) di `docs/deployment.md` dan `docs/PROGRESS.md`. Belum pernah: boleh ubah di tempat. Pernah: pindahkan ke migrasi baru.
- Pola FK (legend-436yt): seragamkan. Tabel baru: FK inline di `CREATE TABLE`, buang angkat NO FORCE/FORCE. Ini juga berlaku untuk 0210, 0212, 0213, 0214, 0216 batch46 bila m1 belum pernah diterapkan ke DB bersama. FK ke tabel lama yang berisi: tanya satu subagent architect (xhigh) untuk polanya, lalu terapkan.
- Bukti: `edge-received-events-migration.test.ts` (seluruh folder sebagai non-superuser) hijau.
- Satu subagent architect review diff migrasi saja (tingkat K).

## Gate
`heavy pnpm test` dari root (api vitest penuh, root node:test), typecheck semua, e2e. Flake dikenal: TEN-06, az-r-whitelabel, PAY-02 saat beban: ulang file itu saja. Postgres "recovery mode" saat run paralel: ulang file yang gagal, catat.
Edit pakai tool Edit, bukan sed. Jangan pkill proses lain. Jangan hapus worktree thread lain. Stempel waktu pakai `date`.

## Akhir
Maju-kan m1, push, hapus worktree dan cabang lokal yang sudah ancestor m1 (tanpa --force), update `docs/PROGRESS.md`, catatan rilis di `docs/release-notes-m1-migrations.md`.
Laporan sekali: SHA m1, tabel penomoran, hasil gate, temuan architect.
