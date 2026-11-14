# Brief: engineer — sisa refund POS/payload-only ke clearing + log parkir (legend-ljs6i, UANG)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
Worktree dari `--worktree`, base `fix/refund-split-journal-fallback` (cda602bc1, kartu legend-qte35, sudah memuat m1 ec4f7dfc6). Cabang akhir: `fix/auto-journal-refund-residual`.

## Tujuan
Lanjutan legend-qte35:
1. `apps/api/.../accounting-auto-journal-amounts.ts` sekitar baris 982: sisa `want > 0` pada refund POS atau refund payload-only masih bisa masuk `gateway_clearing` tanpa bukti sumber. Terapkan aturan yang sama dengan qte35: buktikan sumber (tender/intent), bila tidak terbukti parkir retryable, jangan tebak akun. Refund POS tunai yang sah tidak boleh ikut terparkir.
2. Tambah `console.error` (atau logger error) satu kali pada parkir pertama `AUTO_JOURNAL_REFUND_SOURCE_PENDING`, mengikuti pola dead-letter di `accounting-auto-journal-consumer.ts` sekitar baris 274, tanpa data pribadi.
Jangan sampai rugi: tidak ada jurnal ganda, debit = kredit, total refund tidak melebihi pembayaran.

## Kartu
`legend-ljs6i`. Di awal: `bd update legend-ljs6i --status in_progress` (lewati `ghostex board associate` bila error multi-board). Saat melapor: `bd update legend-ljs6i --status review` dan `bd comment legend-ljs6i "<ringkasan>"`.

## Scope
- Boleh: `accounting-auto-journal-amounts.ts`, `accounting-auto-journal-consumer.ts`, test di apps/api/src/test/.
- Jangan: alur refund order (order-recovery-refund.ts), payout, UI, migrasi (tidak ada nomor; bila butuh, berhenti dan tanya CTO).

## Pembagian paralel (giliran pertama)
- Explore (2): (a) semua jalur yang menghasilkan `want > 0` ke clearing; (b) bukti sumber untuk refund POS (tender rows) dan payload-only.
- test-writer: test gagal-dulu: refund POS tanpa bukti sumber -> parkir, bukan clearing; refund POS tunai sah -> akun benar, tidak parkir; parkir pertama menulis log error satu kali; retry tidak menggandakan jurnal; debit = kredit.
- implementer: satu.
- Pemegang token heavy: satu subagent.
- Review: satu subagent `architect` effort xhigh (uang) pada diff akhir.

## Bukti selesai
- `LEGEND_TEST_FILES="<file test baru> src/test/refund-split-journal-fallback.test.ts <suite auto-journal terkait>" heavy pnpm test` hijau; merah di base tercatat.
- Pra-gate AGENTS.md: prettier, eslint, typecheck api lewat `heavy`.

## Batas kerja ulang
- Typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua, sekali lagi; gagal ketiga lapor.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Aturan uang yang ragu: pilih yang membatasi pembayaran dan tanya CTO.

## Sebelum melapor
Commit hanya file scope, rename cabang ke `fix/auto-journal-refund-residual`, push tanpa force. Jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, cabang akhir, test gagal-dulu, temuan architect, risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
