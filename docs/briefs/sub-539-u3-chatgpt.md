# 539-U3 Tanya AI redesign: ChatGPT-style layout (founder Q46 "Ubah", 12 Nov)

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-mcp`, branch `ui/ai-mcp`. Rules of `docs/briefs/sub-539-u3-ai-mcp.md` apply (own files only, catalog text only, tokens only, light + dark, `@/components/ui/*`, no tsc/build/test/dev server, no commits; `pnpm exec prettier --write <files>` ok). Standard `~/.agents/team/ui-standard.md` (AI UI rules, 44 px targets, no horizontal scroll at 320, reduced motion).

One component serves all 5 areas (`TanyaAiPage area=kelola|owner|shareholder|karyawan|kitchen`), so changing it covers every area.

## Target (founder's words: familiar like ChatGPT)
- Desktop (≥ `lg` of the content area): two columns filling the content height. Left panel (~16rem) = conversation history: "Percakapan baru" button at top, list of own conversations (active one highlighted), "Hapus riwayat" at the bottom of the panel, "Riwayat hanya terlihat oleh Anda" note. Right = chat column.
- Chat column: messages flow in a centered column (max ~42rem), question bubbles right-aligned, answers left with "Tanya AI · Dibantu AI" label and source card (keep `AnswerWithSource`). Composer pinned at the bottom center of the chat column (`sticky bottom-0` inside the scroll area, background so text scrolls under it), same max width as messages, rounded large input with the send button inside/right, note "Jawaban mengikuti izin dan cakupan akses Anda." under it. Banners (unavailable/quota/budget/offline/denied/pii) sit directly above the composer.
- Header stays small: page title "Tanya AI" + "Contoh data" badge; no big card frame around the whole chat (drop the CardShell look; the chat should feel like the page itself).
- Mobile (< `lg`): single column; history opens as a left slide-in panel (existing `Sheet`) from a "Riwayat" button in a slim top bar next to "Percakapan baru". Composer pinned bottom, visible on first paint at 390×844 without scrolling. Primary actions ≥ 44 px.
- Empty / new conversation: centered greeting (catalog, e.g. "Apa yang ingin Anda ketahui hari ini?") + 4 example question chips (from `ChatSuggestions`, below) above the composer; clicking a chip sends that question. Keep the existing empty-history state text only as the sr/secondary hint.
- Keep all behaviour: progressive reveal + stop, "Tanya ulang", aria-live rules (single "jawaban siap" status), delete-history dialog, error/loading skeletons, `?mock=` and `?state=` scenarios, tenant brand name, focus handling.

## Parts (parallel)
### C1 layout — files `components/tanya-ai-page.tsx`, `components/history-pane.tsx`, `components/composer.tsx`
Build the layout above. Import `ChatSuggestions` from `./chat-suggestions` (C2 writes it; signature below) and render it in the empty state with `onPick={(q) => submit(q, activeId)}`.

### C2 suggestions — new file `components/chat-suggestions.tsx`, `logic.ts` (add only), catalog `packages/shared/src/i18n/messages/ws12-ai-chat.ts` (add keys only), test `tests/ws12-ai-ui.test.mjs` (add cases)
- `logic.ts`: `suggestionKeys(area: "kelola" | "owner" | "shareholder" | "karyawan" | "kitchen"): readonly string[]` returns exactly 4 catalog keys `aiChat.suggestions.<group>.<n>`; groups: `manage` (kelola, owner: sales yesterday, best-selling menu this week, stock running low, pending approvals), `shareholder` (profit this month, outlet revenue comparison, dividend schedule, last month report), `staff` (karyawan: my shift this week, leave balance, last payslip date, SOP for closing), `kitchen` (orders waiting now, items out of stock, today's prep list, average cook time). Write natural Indonesian questions in the catalog, plus `aiChat.empty.greeting` and `aiChat.empty.hint`.
- `chat-suggestions.tsx`: `export function ChatSuggestions({ area, onPick, disabled }: { area: ChatArea; onPick: (question: string) => void; disabled?: boolean })` — grid of 4 outline buttons (2 cols ≥ sm, 1 col on phone), each ≥ 44 px, text left-aligned, wraps; uses `useT()`; disabled when asking is paused. `ChatArea` type: import from where `tanya-ai-page.tsx` gets it.
- Tests: `suggestionKeys` returns 4 distinct keys per area, kelola and owner share `manage`, every key exists in the catalog (import the catalog the way the test file already imports logic).

Report: files changed, what changed, anything not done.
