# 539-U3 fix round (mockup comparison)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-mcp`. Rules from `docs/briefs/sub-539-u3-ai-mcp.md` still apply (own files only, no tsc/build/test/dev server, no commits, catalog text only, tokens only, light + dark, `pnpm exec prettier --write <files>` ok).
Mockups: `/Users/ifanshori99/Projects/legend super app/legend/design/mockups/ai/` (read the `.html`; PNGs only for your screen). Current screenshots: `output/ui-check-ai-mcp/<name>-{1440,390,320}.png`.
Report: files changed, what each fix does, anything you could not fix.

## F-admin (P5 files: `apps/web/src/features/ws12-ai-admin/` non-`usage-*`, catalog `ws12-ai-admin.ts`)
1. Clients table at 1440 overflows into the quota card. Give the table wrapper `min-w-0 overflow-x-auto`, let action buttons wrap, and stack the clients card above the quota card below `xl`.
2. Scopes column too tall: show at most 2 scope chips (`MAX_SCOPES_SHOWN = 2`) + a "+N lainnya" chip (catalog text; full list in `title`/tooltip or sr-only). Align badges on one baseline.
3. Revoke dialog: constrain text width so lines do not run edge to edge (match mockup `?state=revoke`). Keep the reason field (contract needs it) and the Q11 copy.

## F-chat (P1 files: `apps/web/src/features/ws12-ai-chat/`, catalog `ws12-ai-chat.ts`)
1. Header at 390 px is cramped: `flex-wrap`, badges and buttons wrap to a second row, primary action ≥ 44 px, no overflow at 320.
2. Source card labels incomplete vs mockup: must read e.g. "Sumber · Laporan penjualan" and "Cafe Legend · Periode …" exactly as `tanya-ai.html` (check casing; no forced uppercase unless the mockup has it).
3. Disabled "Kirim" button too faint: use the standard disabled button style (readable label, contrast ≥ 3:1 against the background), not extra opacity on top.

## F-action-guide (P2 + P3 files: `features/ws12-ai-guide/`, `features/ws12-ai-action/`, catalogs `ws12-ai-guide.ts`, `ws12-ai-action.ts`)
1. `action-detail-page.tsx` (~line 292) and `guide-page.tsx` (~line 85) use `max-w-5xl`; use the full content width like the other area pages (compare `features/ws12-ai-admin/components/*page*.tsx`).
2. Guide text too small and faint: body at base size with `text-foreground` (muted only for secondary notes). Make sure the closing card from `panduan.html` renders.

## F-consent (P4 files: `features/ws12-ai-consent/`, `routes/mcp.consent.tsx`, catalog `ws12-ai-consent.ts`)
1. In mock mode (`VITE_API_MOCK=true`) the consent page always shows the signed-out state because there is no real session, so the approve form is never visible. Treat the mock role as signed in the same way area access does in mock mode (`apps/web/src/lib/areas/access.ts`, `MOCK_ROLE_COOKIE`, default "all"). Real mode must stay unchanged (signed-out state when no session). Keep `pickRawConsentSearch`, resume, bfcache, deny guard as they are.
