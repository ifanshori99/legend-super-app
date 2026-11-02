// Follows a cursor list to its last page (D-CORE-5). Pure: the caller passes
// the fetcher, so the loop is testable without the API client.

/**
 * Safety stop: 50 pages x 100 rows (PAGE_LIMIT_MAX). A catalog larger than
 * this is a data problem worth surfacing, not something to loop over forever.
 */
export const MAX_CATALOG_PAGES = 50;

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/**
 * Fetches page after page until `meta.nextCursor` is null and returns one page
 * holding every row, so screens that filter in memory never see a silently
 * truncated catalog. Throws past `maxPages` instead of looping forever.
 */
export async function collectAllPages<T, P extends Page<T>>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  maxPages: number = MAX_CATALOG_PAGES,
): Promise<P> {
  let cursor: string | undefined;
  let merged: P | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const next = await fetchPage(cursor);
    merged =
      merged === undefined
        ? next
        : { ...next, data: [...merged.data, ...next.data] };
    if (next.meta.nextCursor === null) return merged;
    cursor = next.meta.nextCursor;
  }
  throw new Error(`List has more than ${maxPages} pages; narrow the query.`);
}
