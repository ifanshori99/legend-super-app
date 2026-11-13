# Sub-brief: legend-80oot cek ulang owner di transaksi simpan refresh

Repo: worktree ini, cabang `fix/ai-owner-recheck` (basis fix/ai-login-review 3ba2911a). Tingkat K (auth/akses). Tanpa migrasi. Jangan sentuh apps/web. Jangan login ChatGPT nyata.

## Bug
`apps/api/src/services/ai-chatgpt.service.ts` `getChatgptCredentials` (~l.680-845): owner penyetuju (`row.riskAcceptedBy`) hanya dicek di transaksi klaim, sebelum `refreshChatgptToken` (jaringan). Bila peran owner dicabut saat refresh menunggu, transaksi simpan (`withTenant ... tx.update(T).set({tokensEncrypted...})`) tetap menyimpan token baru dan kredensial dipakai.

## Perilaku benar
Di transaksi simpan: ambil lock koneksi (`lock(tx, tenantId)`), baca ulang baris (`read(tx, tenantId, true)`), cek ulang assignment owner aktif dengan pemeriksaan yang SAMA seperti di klaim (`accessSnapshotInTransaction(...).allowsVia("owner","ai.governance.manage",{type:"tenant"})`). Baris hilang / bukan connected / generation atau operationId berubah: perilaku lama (saved undefined). Owner hilang: `disconnectInTransaction` di transaksi yang sama (token baru TIDAK disimpan), setelah commit `bestEffortRevoke` untuk token baru (`refreshed.refreshToken`) dan token lama yang dikembalikan disconnect, kembalikan `null` (tolak). Jalur ini tidak boleh jatuh ke fallback API key tenant: periksa bagaimana pemanggil (gateway) memperlakukan `null` dari jalur owner-dicabut yang sudah ada di klaim, dan samakan.
Audit event seperti jalur disconnect yang sudah ada.

## Test gagal-dulu (apps/api/src/test/, file baru atau tambahan di ai-chatgpt-device-code.test.ts / ai-chatgpt-review-b.test.ts; ikuti helper yang ada)
Skenario: koneksi connected, token kedaluwarsa, mock `refreshChatgptToken` yang di tengah-tengah (sebelum return) mencabut assignment owner penyetuju. Harap: `getChatgptCredentials` return null; baris koneksi status disconnected, token terenkripsi bukan token baru (tidak ada `ai_chatgpt.refreshed` audit); revoke dipanggil untuk token baru; gateway tidak fallback ke API key tenant. Gagal-dulu karena sebab yang benar (token baru tersimpan/kredensial keluar), bukan setup.

## Bukti selesai
`heavy env LEGEND_TEST_FILES="<file test baru + ai-chatgpt-*.test.ts terkait>" pnpm test`; typecheck api via `heavy`; `pnpm exec eslint` + `pnpm exec prettier --check` file berubah. Satu token heavy: hanya test-runner menjalankannya.

## Revisi (architect, terverifikasi): fallback bocor
`ai-gateway.service.ts:858-866` fallback ke API key tenant bila ChatgptCodexError kind "auth"/"disabled". `null` dari getCredentials -> chatgpt-codex.ts:516 throw ChatgptCodexError("auth") -> fallback. Maka jalur owner-dicabut WAJIB melempar `new ChatgptCodexError("unavailable")` (bukan return null), di DUA jalur:
1. Klaim (service ~l.717-720 dan ~749-751): bawa flag ownerRemoved bersama revokeToken; setelah `bestEffortRevoke`, bila ownerRemoved lempar unavailable (bukan return tokens null).
2. Simpan (service ~l.845-852): ganti `return null` dengan `throw new ChatgptCodexError("unavailable")` setelah revoke; betulkan komentar "gateway never falls back".
Test: (a) test P2 owner-dicabut-di-klaim di ai-chatgpt-review-b.test.ts (~l.376) tambah `saveCustomFallback()` + harap 0 POST ke custom provider; (b) test baru owner-dicabut-saat-refresh harus juga memasang custom fallback dan harap 0 POST (sudah ada, verifikasi); (c) harap ada audit disconnect/revoke (cek nama event yang disconnectInTransaction tulis; jangan menebak).

## Perbaikan test (hasil run: 3 test gagal, bahkan kontrol positif, dengan service HP maupun fix)
Sebab setup (bukan kode service):
1. `approver` dibuat sekali di beforeAll; test P2 (l.~416) `removeAssignments(approver.userId)` permanen, jadi di describe legend-80oot approver sudah bukan owner -> klaim menolak sebelum refresh, kontrol positif 503. Perbaiki: di tiap test baru (dan bila perlu P2) pakai owner BARU: `const o = await newOwner("...")` lalu `seedConnected(o.userId, ...)` dan `removeAssignments(o.userId)`; jangan bagikan owner yang dicabut antar test.
2. `audit_logs.event` bertipe jsonb (AuditEvent), nama aksi ada di `event->>'action'`. Nama aksi disconnect = `ai_chatgpt.revoked` (actor system bila dipaksa), refresh sukses = `ai_chatgpt.refreshed`. Buang `learnDisconnectEvents`/tebakan; hitung dengan `SELECT count(*) FROM audit_logs WHERE tenant_id=$1 AND event->>'action'=$2`. Test P2 dan test baru: audit `ai_chatgpt.revoked` bertambah; test baru: `ai_chatgpt.refreshed` tidak bertambah.
