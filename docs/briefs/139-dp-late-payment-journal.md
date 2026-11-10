# Brief 139: engineer — jurnal DP reservasi dan pembayaran yang telat diterima (legend-o9q9)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (uang dan jurnal): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/dp-late-journal -b ws/dp-late-journal milestone/m1`. Jangan pakai `--worktree` Ghostex.
Sebelum mulai: cek apakah sudah dibetulkan di `integ/m1-batch3`, `integ/m1-batch4`, atau `ws/doit-refund` (`git log --grep`, `git grep`). Bila sudah, `bd comment` dengan bukti dan selesai.

## Tujuan
`bd show legend-o9q9`. Penerimaan DP reservasi dan pembayaran yang diterima telat (setelah pesanan/hari ditutup) tidak dijurnal, sehingga kliring gateway selisih saat settlement. Buat keduanya memposting jurnal yang benar (akun dari mapping CoA yang ada; DP sebagai uang muka/kewajiban sampai dipakai, lalu dipindah saat dipakai di tagihan), idempoten per event, beraudit. Pakai jalur posting jurnal yang sudah ada, jangan buat engine baru.
Di awal: `ghostex board associate legend-o9q9`, `bd update legend-o9q9 --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: modul reservasi (bagian DP), applier/posting jurnal pembayaran, test di `apps/api/src/test/`, migrasi baru hanya bila perlu (laporkan nomornya).
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, adapter dan webhook DOIT, modul refund, `crm-promo-refund.ts`. Bila handler baru harus didaftarkan di salah satu file itu, berhenti dan lapor dulu.

## Bukti selesai
- Test: DP diterima memposting uang muka; DP dipakai di tagihan memindahkan saldo; DP dikembalikan/hangus (bila alurnya ada) benar; pembayaran telat memposting ke hari yang benar sesuai aturan late adjustment; event ganda tidak menggandakan jurnal; debit = kredit; isolasi tenant; saldo kliring gateway = nol setelah settlement di skenario uji.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong atau migrasi tercatat.
- Commit lokal di `ws/dp-late-journal`, jangan push. Tulis `docs/briefs/140-second-opinion-dp-late-journal.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, migrasi, hasil gate, temuan review K, file berubah, bead baru, risiko tersisa.
