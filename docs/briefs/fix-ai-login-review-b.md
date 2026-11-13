# Brief: perbaikan temuan architect login ChatGPT (legend-z83k, bagian B)

Cabang kerja: worktree ini. Tingkat K (auth/akses). Jangan login ChatGPT nyata; pakai fixture.
Boleh diubah: `apps/api/src/services/ai-chatgpt.service.ts`, `ai-provider-config.service.ts`,
`apps/api/src/lib/ai/chatgpt-codex.ts`, `ai-gateway.service.ts` (hanya klasifikasi error fallback),
test di `apps/api/src/test/`. Jangan: `apps/web/**`, `packages/shared`, migrasi.
Test yang ada dan relevan: `ai-chatgpt-device-code.test.ts`, `ai-chatgpt-codex-adapter.test.ts`,
`ai-provider-config.test.ts`, `ai-gateway.test.ts`.

## Temuan (keputusan CTO sudah diambil)

1. **P2 koneksi tetap jalan setelah owner penyetuju kehilangan perannya.**
   `ai-chatgpt.service.ts` ~643-692 (`getChatgptCredentials`), `ai-provider-config.service.ts` ~605.
   `riskAcceptedBy` tidak dicek ulang. Restriktif: saat memberi kredensial, cek `riskAcceptedBy`
   masih punya assignment owner aktif di tenant itu; bila tidak, `invalidate` koneksi
   (status terputus, token dicabut best-effort) dan tolak. Test: owner A dicopot -> permintaan
   berikutnya tidak memakai akun A.
2. **P3 sambung ulang membuang token lama tanpa revoke di OpenAI.** `ai-chatgpt.service.ts` ~336
   (`tokensEncrypted: null`), ~347-352. Buka token lama di transaksi klaim, `bestEffortRevoke`
   setelah commit, seperti `removeChatgptConnection` (~568).
3. **P3 token pemenang balapan dibuang tanpa revoke.** Poll ~519-523: revoke token hasil tukar
   kode perangkat yang dibuang. Refresh ~752-755: revoke bila baris sekarang `disconnected`.
4. **P3 jawaban selesai bisa dibuang lalu dibayar dua kali.** `chatgpt-codex.ts` ~571-572:
   pengecekan ulang setelah jawaban selesai memanggil `getCredentials` yang bisa refresh. Ganti
   dengan baca generasi/status/saklar tanpa refresh; bila gagal di titik itu, pakai jenis error
   yang TIDAK memicu fallback ke API key tenant (`ai-gateway.service.ts` ~863-866).

## Aturan tes
- Jalankan: `heavy env LEGEND_TEST_FILES="src/test/a.test.ts src/test/b.test.ts" pnpm test`
  dari root worktree (path relatif `src/test/...`). Hanya satu proses test/tsc pada satu waktu.
- Jangan `pkill`/`killall`.

## Peta kode (hasil Explore)
- Cek owner aktif (temuan 1): `accessSnapshotInTransaction(tx, context, row.riskAcceptedBy, new Date())`
  dari `services/permission-resolver.ts:219`, lalu `.allowsVia("owner","ai.governance.manage",{type:"tenant"})`
  (sama dengan `routes/ai-chatgpt.routes.ts:25`). Taruh di `getChatgptCredentials` transaksi klaim (~662)
  setelah cek status/generation; gagal -> `invalidate` + tolak. Juga `getChatgptProviderState`
  (`ai-chatgpt.service.ts:572`) dipakai `ai-provider-config.service.ts` ~605.
- `invalidate` 168-194, `bestEffortRevoke` 291-296, `removeChatgptConnection` 529-570.
- Sambung ulang `startChatgptConnection` ~336-352; poll `saved` kosong 519-523 (token `result.tokens`);
  refresh `saved` kosong 752-755 (token `refreshed`).
- Temuan 4: `chatgpt-codex.ts:569-574` panggil `getCredentials` lagi; ganti dengan
  `getChatgptProviderState`/`chatgptConnectionVersionOf` (`ai-chatgpt.service.ts:766`) dan lempar
  `ChatgptCodexError("unavailable")` (kind `unavailable` TIDAK memicu fallback; `auth`/`disabled` memicu,
  `ai-gateway.service.ts:856-867`).
