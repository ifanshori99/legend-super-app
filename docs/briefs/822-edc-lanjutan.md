# 822 EDC lanjutan: nominal writeAhead, pembersih needs_reconciliation, guard void QR (engineer, tingkat K uang)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/fix/edc-bill-lock` (8185a7ebd, kunci tagihan EDC-01 dengan kode `EDC_REQUEST_OPEN`). Cabang akhir `fix/edc-followups` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-xcbs7`, `legend-x9zmq`, `legend-kiibf`. Di awal `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Tujuan
1. legend-xcbs7: `writeAhead` di EDC agent menolak permintaan bila nominal tidak sama dengan sisa tagihan saat itu (layar POS basi). Pakai advisory lock yang sama dengan guard EDC-01.
2. legend-x9zmq: `needs_reconciliation=true` sekarang mengunci tagihan tanpa batas (tidak ada kode non-test yang membersihkannya). Buat jalur resmi: tindakan "selesaikan rekonsiliasi" setelah inquiry atau bukti terminal, oleh Owner atau Finance Manager (keputusan founder Q12: satu tingkat, salah satu cukup), tercatat di audit. Hasil: final declined (kunci terbuka, tagihan tetap belum lunas) atau final approved (jadi tender, tagihan lunas). Cari dulu fitur kasus rekonsiliasi yang sudah ada dan pakai itu.
3. legend-kiibf: verifikasi apakah pesanan QR menunggu bayar bisa punya permintaan EDC; bila bisa, guard `EDC_REQUEST_OPEN` di `voidAwaitingPaymentOrderTx`; bila tidak, test yang membuktikannya.

## Keputusan CTO
Aturan founder jangan sampai rugi: pelanggan tidak ditagih dua kali, outlet tidak kurang. Bila ragu, pilih yang menolak. Kunci tidak pernah dibuka oleh timeout saja.

## Scope
- Boleh: service POS order/payment, EDC agent writeAhead, service rekonsiliasi, permission di `packages/shared/src/permissions.ts` bila perlu, test.
- Jangan: migrasi (bila perlu kolom/tabel baru: berhenti dan lapor, nomor 0381), DOIT/payout, panik, pemindai, edge sync.

## Paralel
- Explore x3: (a) writeAhead + alur EDC agent, (b) needs_reconciliation dan fitur kasus rekonsiliasi, (c) pesanan QR menunggu bayar.
- test-writer: test gagal-dulu per kartu.
- implementer x3, satu per kartu (file tidak bertumpuk; bila bertumpuk, berurutan).
- Pemegang token heavy: test-runner.

## Bukti selesai
- Test terarah file pos-edc-*, edc-*, pos-order-*, rekonsiliasi yang tersentuh lewat `heavy`; gagal-dulu tercatat.
- Test uang: nominal EDC = sisa tagihan; setelah rekonsiliasi tidak ada tagihan dobel atau kurang.
- Pra-gate AGENTS.md (prettier, eslint, text-contract bila ada teks baru, `heavy pnpm --filter @starter/api typecheck`).
- Satu subagent architect effort xhigh atas diff; temuan nyata dibetulkan.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, per kartu apa yang berubah, test, hasil architect, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
