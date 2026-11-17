# 972 gate (test-runner, pemegang token heavy)

Worktree: /Users/ifanshori99/Projects/legend super app/legend-dd932307. Selalu `cd` ke sana dulu. Satu perintah sederhana per panggilan Bash. Jangan edit kode; lapor kegagalan saja (baris ttes + 1 pesan error).

Berkas berubah: `git status --porcelain` (diff vs HEAD, termasuk untracked).

Urutan (semua lewat `heavy`, satu per satu):
1. `pnpm exec prettier --check <berkas ts/mjs/json berubah>`, lalu `pnpm exec eslint <berkas ts berubah>` (dari apps/api untuk berkas api bila perlu).
2. Typecheck API lalu typecheck web (shared berubah: payables.ts menambah "employee" dan counterpartyType di row list). Cari script di package.json (`pnpm --filter @starter/api typecheck` atau sejenis). Satu tsc sekaligus.
3. `LEGEND_TEST_FILES="<daftar>" heavy pnpm test` dengan: tiga tes 972 (payroll-loan-disburse-offboarding-972, payroll-gl-pph21-refund, payroll-pph21-receivable-open-item-972) + semua tes yang menyebut payroll-run-lock / payroll-run-reversal / accounting-open-items / accounting-ap-fa / payroll-loans / hris-offboarding / data-import-registry / payroll-core-db (grep `apps/api/src/test`), path relatif ke apps/api. Pecah jadi beberapa panggilan bila banyak.
4. `node --test tests/payroll-pph21-refund-journal.test.mjs` lewat `pnpm test` bila perlu (lihat aturan root test) dan tes kontrak packages/shared terkait payables.
5. `pnpm db:generate` harus melaporkan tidak ada perubahan (jangan commit hasilnya; bila membuat berkas baru, hapus dan lapor).
Laporan: tiap langkah hijau/merah, perintah, kegagalan saja.
