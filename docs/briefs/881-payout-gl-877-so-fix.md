# 881 Perbaikan second opinion payout GL 877 (2 P1 + 1 P2)
Lanjutan di cabang `fix/payout-gl-877` (tip d1e259ed4), worktree yang sama. Baca seluruh `docs/qa/second-opinion-payout-gl-877.md` (folder utama repo). Kartu: `legend-pfk3q`, `legend-zlcsd`, `legend-63qhw` (associate + in_progress di awal; review + comment saat lapor). Migrasi baru: rentang sementara 0626-0629 (0620 tetap). FORCE RLS: tanpa FK NOT VALID.

## Keputusan CTO (jangan ditanyakan ulang; aturan yang membatasi)
- pfk3q: jurnal lock dan event outbox tetap jalan (outbox tidak boleh tertahan), tetapi settlement yang belum bisa dijurnal (mapping biaya hilang, sumber nonpostable) dicatat sebagai kewajiban pemulihan yang tahan lama: `fee_posted` tidak boleh true bila biaya belum dijurnal; posting itu muncul di daftar finance (`listSkippedFees` atau daftar sejenis, dengan alasan), dan diulang otomatis oleh worker/job berkala atau saat mapping berubah, idempoten. Test lewat outbox sungguhan + jalur worker/endpoint publik, bukan helper internal: 2103 benar, kredit sumber pokok + biaya tepat sekali, replay/paralel tidak menambah jurnal.
- zlcsd: identitas akun sumber disimpan saat serah terima/konfirmasi walau akun itu sementara nonpostable; resolver tidak pernah mengganti dengan mapping saat ini. Baris lama tanpa sumber (kas null, bank legacy `sourceBankAccountId` null): settlement ditahan untuk rekonsiliasi, finance mencatat sumber sebenarnya lewat endpoint ber-permission yang ada atau baru (requirePermission, requireTrustedOrigin), lalu resolve sekali. Tidak menebak dari konfigurasi.
- 63qhw: trigger transisi `settle_pending→settle` dan `settle_skipped→settle` menolak bila tidak ada jurnal tenant yang sama dengan `journal_key` posting itu; test dengan role `legend_app` + konteks tenant (tanpa jurnal ditolak, jurnal benar dalam transaksi sama diterima, jurnal tenant/key lain ditolak).

## Bukti selesai
- Test merah dulu di d1e259ed4, hijau sesudah; ditambah 8 berkas payout/GL/registry: `LEGEND_TEST_FILES="<daftar>" heavy pnpm test`.
- Pra-gate AGENTS.md (prettier, eslint, `pnpm db:generate` kosong, `heavy pnpm --filter @starter/api typecheck`; web juga bila shared berubah).
- Review: satu subagent architect effort xhigh atas diff; temuan nyata dibetulkan.
- Paralel: Explore per temuan, test-writer, implementer per temuan (berkas `payroll-payout-gl.service.ts` dibagi per fungsi atau berurutan), satu test-runner pemegang heavy.
- Commit + push tanpa force. Lapor sekali saat selesai (tunggu job dengan Monitor di giliran yang sama): SHA, migrasi, merah→hijau, angka subagent. Jangan merge, jangan deploy.
