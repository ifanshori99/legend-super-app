# Brief 114: merge train m1, lanjutan (gate batch)

Peran: engineer (merge train). Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/89*` (aturan merge train, pemilik cabang di 89c, merge asli bukan squash di 89a).
Lanjut dari `docs/PROGRESS.md` bagian "Merge train 89", baris serah terima. m1 terakhir hijau: 97702627; DOIT dab1d592 di atasnya.

## Aturan gate (retro 9 Nov)
- Maks 2 `pnpm check` sekaligus di Mac. Jangan gate per cabang.
- Batch: `integ/m1-batchN` dari m1, `merge --no-ff` berurutan (regen nomor migrasi saat bentrok), typecheck + test terarah tiap merge, lalu satu `pnpm check`. Lulus: fast-forward m1. Gagal: ulang file gagal sekali (flake beban), lalu bisect per cabang dan kirim kegagalan ke thread pemilik.

## Batch 1 (urutan)
m007 19640b63, EDC 3fbfe167 (prep) / 164fa725, refund ws/fix-codex-refund bcd745e6 + ws/fix-refund-quarantine-ops 84a89e35, journals-expiry dfae77ae, testdb-cleanup bd04eef1 (mem_limit 512m; 'connection terminated' -> 768m), ws-09-ws 1e94f33f, po-pdf-font 72c15e21.

## Batch 2
fix-codex-procurement 598a39e9, fix-codex-shift 92449b85, fix-codex-kds 673ebc36, checklist-schedule 286d1993, ws09-wifi b9d7e40b + ws09-wifi-hardening d2710c47, whitelabel prep4 2d0f7f4a + receipt 39296fae bila belum masuk, e2e-az c01e9c63.

## Batch 3 (besar)
ai-tool-catalog d15542a8 lalu ws12-ai 9f6d680e, ws03-menu d06b163c, ws08-site 0800ac71 (kontrak approvedBy nullable), pph21-prior 10051952, ws11 bila tripwire sudah dibetulkan.

Cek tiap SHA masih HEAD cabangnya (`git rev-parse <cabang>`); pakai HEAD terbaru bila pemilik menambah commit. Lapor per batch: SHA m1, hasil gate, cabang yang dikembalikan.
