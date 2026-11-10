# Brief: engineer (Opus) — WS-03 split bill dan pembayaran per tamu

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/split-bill` dari `milestone/m1` (d2080951 atau ujung terbaru). Worktree `.worktrees/split-bill`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Disk Mac sempit: jangan buat worktree tambahan.

Nomor migrasi dipesan: `0202`, `when` 1794281000000, satu migrasi.

## Tujuan
`legend-ms3` (P2, tingkat K uang). PRD v1.7 §3 F10 Split Bill dan Klaim Poin per Orang, §6 D `bill_splits`, kriteria ORD-06. Audit 9 Nov: di m1 hanya ada UI mock (`apps/web/src/features/ws03-qr-order/components/bill/split-panel.tsx`, `mock-engine.ts`) dan `packages/shared/src/qr-order/pricing.ts`; belum ada route, service, tabel, pembulatan, token klaim, atau test.

Bangun:
1. Tabel `bill_splits` (dan baris per bagian bila perlu) untuk satu tagihan: mode rata, per orang, per item. Pola `tenantIdColumn`, `outlet_id`, unik dengan `tenant_id`, FK komposit, RLS lewat `.custom.sql`.
2. Pembulatan largest-remainder: jumlah semua bagian sama persis dengan total tagihan (rupiah bulat, pajak dan servis ikut terbagi tanpa selisih). Pakai helper uang di `packages/shared/src/core/money.ts` bila cocok.
3. Pembayaran per tamu: tiap bagian punya payment intent sendiri lewat service pembayaran yang ada; tagihan lunas hanya bila semua bagian lunas. Bagian yang sudah dibayar tidak boleh dibagi ulang.
4. Token klaim poin per bagian, berlaku 24 jam, sekali pakai. Penambahan poin ke member belum ada (buku poin `legend-111j` sedang didesain architect di cabang `docs/arch-member-loyalty`): simpan token dan statusnya saja, lalu buat kartu bd untuk penukaran token yang menunggu `legend-111j`.
5. Kontrak di `packages/shared/src/qr-order/*` dan route di `apps/api/src/routes/qr-order.routes.ts` (atau berkas route baru di sampingnya).

Mulai dengan `Explore` untuk memetakan service tagihan/QR order, payment intent, dan arti "split" yang sudah ada (`payment-refund-qr-split-guard`, `accounting-auto-journal-split-qr-*` mungkin tentang multi-tender, bukan split bill). Desain skema dan aturan uang lewat satu subagent `architect`, catat di `docs/DECISIONS.md`. Sesudah skema masuk, route dan test boleh lewat `implementer` paralel di berkas terpisah.

## Kartu
Awal: `ghostex board associate legend-ms3`, `bd update legend-ms3 --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa. Sambungan UI split-panel ke API sungguhan: kartu terpisah.

## Scope
Boleh: schema/service/route split bill, migrasi 0202, `packages/shared/src/qr-order/*`, test. Jangan: UI web, buku poin atau saldo member, refund, jurnal akuntansi, fitur link meja (`ws/table-link` belum masuk m1: jangan sentuh berkas `table-link*`), checkout fasilitas.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Test gagal-dulu: jumlah bagian sama persis dengan total untuk tiap mode (termasuk total yang tidak habis dibagi); isolasi tenant dan outlet; bagian yang sudah dibayar tidak bisa dibagi ulang; tagihan baru lunas sesudah semua bagian lunas; bayar dua kali dengan kunci idempoten sama hanya sekali; token klaim kedaluwarsa sesudah 24 jam dan tidak bisa dipakai dua kali.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- Typecheck api dan shared lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh atau `pnpm test` penuh.
- Review (tingkat K): satu subagent `architect` untuk diff gabungan.
- Tulis brief Codex `docs/briefs/294b-second-opinion-split-bill.md` (uang + migrasi: xhigh), jangan dijalankan.

## Laporan
Sekali di akhir: keputusan desain, SHA, migrasi (`when`, prevId), bukti, file berubah, kontrak untuk UI, kartu baru, risiko, jumlah subagent dan puncak bersamaan.
