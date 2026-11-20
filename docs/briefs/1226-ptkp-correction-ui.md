# 1226 UI koreksi PTKP karyawan (bead legend-du7t5, syarat gerbang rilis)

Cabang `ws/1223-ptkp-tax-year` (worktree `/Users/ifanshori99/Projects/legend super app/legend-1223`, HEAD 300e989bb). Ikuti `~/.agents/team/ui-standard.md`. API sudah ada: `PUT /api/hris/employees/:id/ptkp` (lihat `apps/api/src/services/hris-employee-ptkp.service.ts`, kontrak di packages/shared). Aturan umum test/commit: `docs/briefs/1217-1220-fix-so1216.md`.

- Di detail/edit karyawan HR: aksi "Koreksi status PTKP" (dialog): status, tanggal berlaku (pilihan: awal tahun pajak / tanggal masuk, atau hari ini), alasan wajib. Hanya untuk pemegang izin yang diminta API (sembunyikan bila tidak; API tetap penjaga).
- Sesudah sukses tampilkan status tahun ini + status berlaku berikutnya (dengan tanggal) dari respons.
- Pesan jelas untuk 409 tahun tertutup (slip tahunan sudah dikunci) dan 422 tanggal tidak valid. Bila form karyawan biasa masih bisa mengubah PTKP langsung, beri keterangan bahwa perubahan biasa berlaku tahun depan dan koreksi salah input lewat aksi ini.
- Pola: feature api/queries/hooks; teks ke katalog (`node --test tests/text-contract.test.mjs`), prettier/eslint, `heavy pnpm --filter @starter/web typecheck`, test web fitur karyawan bila ada. Budget 35 tool call. Commit + push, lapor SHA.
