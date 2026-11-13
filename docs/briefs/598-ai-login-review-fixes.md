# Brief: engineer — perbaikan temuan architect login ChatGPT (bagian B)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti. Tingkat K (auth/akses).

## Repo
Worktree baru dari `ws/ai-login-autodetect` (eb1df93a, sudah dibuat Ghostex). Commit di cabang kerja, lalu push ke `origin` sebagai `fix/ai-login-review` (bukan ke ws/ai-login-autodetect).

## Tujuan
Betulkan 4 temuan review architect xhigh (verdict: lolos dengan perbaikan). Keputusan CTO sudah diambil, tidak perlu ditanyakan.

1. **P2 — koneksi tetap jalan setelah owner penyetuju kehilangan perannya.** `apps/api/src/services/ai-chatgpt.service.ts:643-692` (`getChatgptCredentials`), `ai-provider-config.service.ts:605`; `riskAcceptedBy` tidak dicek ulang. Keputusan CTO (restriktif): saat memberi kredensial, cek `riskAcceptedBy` masih punya assignment owner aktif di tenant itu; bila tidak, `invalidate` koneksi (status terputus, token dicabut best-effort) dan tolak. Test: owner A dicopot -> permintaan berikutnya tidak memakai akun A.
2. **P3 — sambung ulang membuang token lama tanpa revoke di OpenAI.** `ai-chatgpt.service.ts:336` (`tokensEncrypted: null`), `:347-352`. Buka token lama di transaksi klaim, `bestEffortRevoke` setelah commit, seperti `removeChatgptConnection` (`:568`).
3. **P3 — token pemenang balapan dibuang tanpa revoke.** Poll `:519-523`: revoke token hasil tukar kode perangkat yang dibuang. Refresh `:752-755`: revoke bila baris sekarang `disconnected`.
4. **P3 — jawaban selesai bisa dibuang lalu dibayar dua kali.** `apps/api/src/lib/ai/chatgpt-codex.ts:571-572`: pengecekan ulang setelah jawaban selesai memanggil `getCredentials` yang bisa refresh. Ganti dengan baca generasi/status/saklar tanpa refresh; bila gagal di titik itu, pakai jenis error yang TIDAK memicu fallback ke API key tenant (`ai-gateway.service.ts:863-866`).

## Kartu
`legend-z83k`. Di awal: `bd update legend-z83k --status in_progress`. Saat melapor: `bd update legend-z83k --status review` dan `bd comment legend-z83k "<ringkasan>"`.

## Scope
- Boleh diubah: `apps/api/src/services/ai-chatgpt.service.ts`, `ai-provider-config.service.ts`, `apps/api/src/lib/ai/chatgpt-codex.ts`, `ai-gateway.service.ts` (hanya klasifikasi error fallback), test di `apps/api/src/test/`.
- Jangan disentuh: `apps/web/**` (thread lain sedang menyambungkan UI), `packages/shared` DTO, migrasi (tidak perlu migrasi baru; bila terpaksa: `0432-0433`).
- Jangan login ChatGPT nyata; pakai fixture.

## Pembagian paralel (giliran pertama)
- test-writer: test gagal-dulu untuk keempat temuan.
- implementer (2, file terpisah): (a) `ai-chatgpt.service.ts` + `ai-provider-config.service.ts` (temuan 1-3); (b) `chatgpt-codex.ts` + klasifikasi error gateway (temuan 4).
- reviewer: satu `architect` effort xhigh atas diff akhir.
- Pemegang token heavy: satu `test-runner`.

## Bukti selesai
- Bukti gagal-dulu, lalu `heavy env LEGEND_TEST_FILES="<test AI terkait>" pnpm test` hijau.
- Typecheck API lewat `heavy`. Pra-gate AGENTS.md: prettier, eslint pada file berubah.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
- Jam di laporan: `date '+%H:%M'`.
- Jangan merge ke milestone/m1 atau main; jangan deploy.

## Laporan
Hasil, bukti, file berubah, commit, risiko tersisa.
Wajib satu baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
