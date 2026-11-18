// Shared helpers for the brief 936 POS payment component tests (voucher,
// points, EDC declined, display QRIS label, ticket). Components are rendered
// on the server (no browser) with their hooks mocked, so these tests assert
// what the cashier reads and which buttons are locked, never CSS.
import { formatRupiah } from "@starter/shared/i18n";

/** Visible text of server-rendered HTML: tags, comments and nbsp normalised. */
export function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|\u00a0/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** "Rp 27.300" as the screen shows it (nbsp turned into a plain space). */
export function rupiah(amount: number): string {
  return formatRupiah(amount).replace(/\u00a0/g, " ");
}

export type RenderedButton = {
  label: string;
  disabled: boolean;
  busy: boolean;
};

/** Every <button> in the HTML: its visible label and lock state. */
export function buttonsOf(html: string): RenderedButton[] {
  const found: RenderedButton[] = [];
  for (const match of html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)) {
    const attrs = match[1] ?? "";
    found.push({
      label: visibleText(match[2] ?? "").trim(),
      disabled: /\sdisabled(=|\s|$)/.test(` ${attrs}`),
      busy: /aria-busy="true"/.test(attrs),
    });
  }
  return found;
}

/** A react-query-shaped mutation result for a mocked hook. */
export function mutation<TData = unknown>(
  over: Partial<{
    data: TData;
    error: unknown;
    isPending: boolean;
  }> = {},
) {
  const isPending = over.isPending ?? false;
  return {
    data: over.data,
    error: over.error ?? null,
    isPending,
    isError: over.error != null,
    isSuccess: over.data !== undefined && !isPending,
    mutate: () => {},
    mutateAsync: async () => undefined,
    reset: () => {},
  };
}
