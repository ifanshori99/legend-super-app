# 883 Perbaikan second opinion delta payout GL 881 (2 P1 + 4 P2)
Lanjutan di `fix/payout-gl-877` (tip 61102bff0), worktree yang sama. Baca seluruh `docs/qa/second-opinion-payout-gl-881.md` (folder utama repo). Buat kartu bd per temuan P1/P2 (prefix "SO-881"), associate + in_progress; saat lapor review + comment. Migrasi baru (bila perlu): 0627-0629. FORCE RLS tanpa FK NOT VALID.

## Keputusan CTO (aturan yang membatasi)
- Sweep pemulihan: tidak boleh ada batch yang terus terlewat. Urutan adil (paling lama dulu / kursor), baris tertahan permanen tidak menyumbat; test kelaparan merah dulu.
- Step-up endpoint sumber (dan endpoint payout baru lain di diff ini): pakai pola step-up yang sama dengan approval payout yang sudah lolos second opinion sebelumnya; faktor MFA yang baru didaftarkan dalam sesi/permintaan yang sama tidak boleh dipakai sebagai bukti step-up. Bila pola itu belum ada, tolak (fail closed) dan lapor.
- P2: perbaiki semua dengan aturan yang paling membatasi pembayaran dan pencatatan. Bila sebuah P2 butuh keputusan bisnis (bukan teknis), jangan tebak: tahan perilaku lama yang lebih ketat dan tulis pertanyaannya di laporan.
- Keputusan lama tetap: biaya skipped tanpa jurnal lock manual (reason `accounting_was_off`).

## Bukti selesai
- Test merah dulu di 61102bff0, hijau sesudah; ditambah 26 berkas payout/GL/registry (`LEGEND_TEST_FILES=... heavy pnpm test`).
- Pra-gate AGENTS.md (prettier, eslint, `pnpm db:generate` kosong, typecheck API, web bila shared berubah).
- Review: satu subagent architect effort xhigh atas diff; temuan nyata dibetulkan.
- Paralel: Explore per temuan, test-writer, implementer per temuan (berkas tumpang tindih berurutan), satu test-runner pemegang heavy.
- Commit + push tanpa force. Lapor sekali saat selesai (tunggu job dengan Monitor di giliran yang sama). Jangan merge, jangan deploy.
