# Brief: engineer — perbaikan 3 P1 + 1 P2 second opinion EDC kunci tagihan

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Buat worktree baru dari `origin/fix/edc-qris-confirm-lock` (7e32d2707), cabang `fix/edc-so-829`.

## Tujuan
Tutup semua temuan di `docs/qa/second-opinion-edc-kunci-tagihan.md` (P1 x3, P2 x1) sehingga tidak ada pembayaran ganda dan tidak ada bukti charge kartu yang hilang.

## Kartu
`legend-ftsq0`. Di awal: `ghostex board associate legend-ftsq0`. Saat lapor: `bd comment legend-ftsq0 "<ringkasan>"`.

## Keputusan CTO (jangan diubah)
- Fail-closed: kunci tagihan tahan restart tetap terpasang sampai sale DAN cancel final dan tidak mungkin ada respons sale tertunda. Jawaban cancel saja bukan bukti sale selesai.
- Selama kunci terpasang: tunai, QRIS baru, ubah, dan void tagihan ditolak (sudah aturan).
- QRIS yang tertangkap webhook saat sale kartu masih terbuka lalu kartu approved: kartu menang, QRIS di-void + refund penuh otomatis (menunggu konfirmasi founder Q5; tulis aturannya di satu tempat agar mudah diganti). Kartu declined: tagihan terbuka lagi, QRIS tetap sah.
- `unknown` tanpa flag (terminal tanpa inquiry/cancel): jalur penyelesaian Owner/Finance Manager berbasis bukti + MFA, tetap fail-closed sampai lewat batas waktu respons tertunda.
- Rekonsiliasi `declined` hanya bila sale terbukti tidak bisa menagih lagi (bukti final + keadaan wire), termasuk setelah restart.
- P2: event penyelesaian rekonsiliasi ditulis ke outbox atomik bersama ledger, juga saat status tetap tapi flag berubah.
- Aturan "jangan sampai rugi": test wajib membuktikan tidak ada pihak dibayar lebih dan outlet tidak rugi.

## Scope
- Boleh: `apps/api/src/services/pos-order-support.ts`, `pos-order-payment.ts`, `edc-reconciliation.service.ts`, `pos-edc-standalone.ts`, `apps/api/src/edge/edc/**`, test terkait di `apps/api/src/test/`.
- Jangan: web, migrasi di luar rentang. Migrasi bila perlu: hanya 0381.

## Pembagian paralel (giliran pertama)
- Explore (2): alur kunci/guard + agent EDC; rekonsiliasi + outbox.
- test-writer: 4 test gagal-dulu sesuai "Usul test" tiap temuan, dijalankan terhadap base dan dicatat merahnya.
- implementer (3, file tidak bertumpuk): guard/kunci (pos-order-support + payment), agent EDC, rekonsiliasi + outbox.
- Pemegang token heavy: satu test-runner.
- Review akhir: satu subagent architect effort xhigh (uang).

## Bukti selesai
- `LEGEND_TEST_FILES="<test EDC/rekonsiliasi>" heavy pnpm test` hijau; daftar test merah-dulu.
- Pra-gate AGENTS.md (prettier, eslint, typecheck API sekali lewat heavy).
- Push cabang tanpa force; laporan berisi angka subagent (total, puncak, pemegang heavy).
