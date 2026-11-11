// Small pieces shared by the AI & MCP admin cards.
import * as React from "react";
import { cn } from "cn";
import type { Translate } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

/** The card look of the mockup: hairline border on the raised surface. */
export function AdminCard({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "grid min-w-0 content-start gap-4 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Renders `**bold**` marks of a catalog sentence. Names that come from the
 * server are stripped of `*` first so they cannot change the formatting.
 */
export function RichText({ text }: { text: string }) {
  const parts = text.split("**");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <strong key={index} className="font-semibold text-foreground">
            {part}
          </strong>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

export const plain = (value: string) => value.replaceAll("*", "");

export function isOfflineError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

/** Plain-words reason a change did not save, with how to recover. */
export function saveErrorText(t: Translate, error: unknown): string {
  if (isOfflineError(error)) return t("aiAdmin.saveError.offline");
  if (error instanceof ApiError && error.status === 403)
    return t("aiAdmin.saveError.forbidden");
  return t("aiAdmin.saveError.generic");
}

/** Field messages the API sent with a 422, keyed by field name. */
export function serverFieldErrors(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (error instanceof ApiError)
    for (const detail of error.details ?? [])
      out[detail.field] ??= detail.message;
  return out;
}
