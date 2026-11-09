# Brief 102: fix temuan Codex EDC (4 P1, tingkat K, uang dan data kartu)

EDC adalah satu-satunya jalur kartu saat rilis (keputusan founder 2026-11-09), jadi temuan ini menahan rilis.

## Temuan Codex second opinion (brief 60, run G1l29, rentang `fd2616f4..658b055b`)
1. `apps/api/src/edge/edc/agent.ts:319`
   - Masalah: `not_found` melewati validasi trace. Respons untuk B dengan batch cocok bisa membuat transaksi A `failed`, lalu retry menagih ulang A.
   - Fix: validasi trace sebelum outcome diproses.
2. `apps/api/src/edge/edc/agent.ts:1061`
   - Masalah: dispatch tidak memeriksa ulang kepemilikan outlet. `stop()` saat preflight menunggu memungkinkan agent pengganti dan operasi lama mengirim bersamaan lewat antrean berbeda.
   - Fix: validasi generasi kepemilikan sebelum dispatch, dan tuntaskan operasi sebelum melepas lock.
3. `apps/api/src/edge/edc/agent.ts:953`
   - Masalah: inquiry memakai konfigurasi terminal yang bisa berubah. Setelah A menagih dan respons hilang, penggantian TID/MID/IP ke B dengan batch sama membuat `not_found` mengizinkan penagihan kedua.
   - Fix: simpan identitas terminal saat dispatch, atau blokir penggantian selama ada transaksi belum selesai.
4. `packages/shared/src/edc/index.ts:143`
   - Masalah: `cardType` menerima PAN utuh. Contoh `"4111111111111111"` lolos validasi, tersimpan, lalu dikirim ke POS. Ini masalah PCI.
   - Fix: allowlist jenis kartu, dan tolak PAN di batas respons provider. Cek juga data lama atau log yang mungkin sudah menyimpan PAN.

## Aturan
- Tiap temuan: test merah dulu, lalu fix. Empat temuan bisa dikerjakan paralel oleh subagent bila file tidak bertumpuk; temuan 1–3 di `agent.ts` sebaiknya satu implementer berurutan.
- Basis: worktree `.worktrees/fix-edc-codex`, cabang `ws/fix-edc-codex` dari `milestone/m1` terbaru.
- Review: reviewer Opus dan architect. Gate sekali lewat `heavy`. Commit lokal, lalu handoff ke merge train.
