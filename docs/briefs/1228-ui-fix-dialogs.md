# 1228 Perbaikan UI dialog PTKP (1226) dan batal persetujuan distribusi (1224)

Peran: ui-engineer (tugas kecil, Sonnet). Base `int/batch103` (sesudah merge train 1227 selesai). Worktree baru: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-1228" -b ws/1228-ui-fix-dialogs int/batch103`, lalu `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Ikuti `~/.agents/team/ui-standard.md`.

## PTKP `apps/web/src/features/ws10-employee-master/components/ptkp-correction-dialog.tsx`
1. P2 uang/pajak: hapus regenerasi idempotency key di `onError` (~baris 143). Retry input sama harus pakai key sama.
2. Blok tutup dialog (Esc, overlay, X) selama `correct.isPending`.
3. Fokus field invalid pertama (status lalu alasan); sesudah simpan fokus tombol Tutup di hasil; live region ada sebelum isi.
4. Copy: opsi tanggal berlaku jelas, mis. "Mulai tahun pajak berikutnya (1 Jan 2027)" bukan "Hari ini"; deskripsi dipendekkan 1-2 kalimat; footer sticky di sheet mobile.
5. Tolak/disable bila status dan tanggal sama dengan yang berlaku.

## Distribusi `features/ws07-accounting/components/reason-dialog.tsx`, `distribution-wizard.tsx`, `distribution-runs-table.tsx`
1. Tombol submit tidak disabled karena pendek: klik menampilkan `minLengthError` + fokus; counter "x/10".
2. Error server (`hasAdjustment`, `partiallyPaid`, lainnya) di slot `formError` role=alert di atas footer, bukan error field; kode lain dipetakan ke katalog + fallback "Coba lagi".
3. Blok tutup selama pending; textarea readOnly saat pending. Tanpa `autoFocus` di pointer coarse.
4. Judul menyebut periode, hint menyebut jumlah. Prop `cancelLabel` ("Kembali") agar tidak tertukar dengan "Batalkan persetujuan".
5. Badge "Perlu koreksi": target 44px di pointer coarse, focus ring; aria berbeda bila hanya membuka (bukan membatalkan).
6. Angka 10 dari satu konstanta (interpolasi `{min}`).

## Bukti
Test komponen bila ada pola (vitest web); `node --test tests/text-contract.test.mjs`; prettier + eslint berkas berubah; `heavy pnpm --filter @starter/web typecheck`; screenshot 390 dan 1280 kedua dialog lewat `heavy` (Playwright, simpan `docs/review/img/1228-*.png`). Commit, push. Budget 50 tool call; di 40 commit + lapor.
