// Label + control + hint + error, wired for assistive tech: the control gets
// id, aria-describedby, aria-invalid, and aria-required; the error is
// announced when it appears (WCAG 2.2 SC 3.3.1, 4.1.3).
import * as React from "react";
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import { Slot } from "radix-ui";
import type { z } from "zod";
import { useT } from "@/components/i18n";
import { Label } from "@/components/ui/label";

/**
 * First message per field from a Zod error, keyed by top-level field name:
 * fieldErrors(result.error).phone → "Nomor WhatsApp wajib diisi".
 */
export function fieldErrors(
  error: z.ZodError | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const issue of error?.issues ?? []) {
    const key = String(issue.path[0] ?? "");
    out[key] ??= issue.message;
  }
  return out;
}

type FormFieldProps = {
  label: React.ReactNode;
  /** Ties the label to the control; generated when omitted. */
  id?: string;
  hint?: React.ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  /** Exactly one control (Input, SelectTrigger, Textarea, …). */
  children: React.ReactElement;
};

function FormField({
  label,
  id,
  hint,
  error,
  required = false,
  className,
  children,
}: FormFieldProps) {
  const t = useT();
  const autoId = React.useId();
  const controlId = id ?? autoId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy =
    [hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div data-slot="form-field" className={cn("grid gap-1.5", className)}>
      <Label htmlFor={controlId}>
        {label}
        {!required && (
          <span className="font-normal text-muted-foreground">
            ({t("common.optional")})
          </span>
        )}
      </Label>
      <Slot.Root
        id={controlId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
      >
        {children}
      </Slot.Root>
      {hint && (
        <p id={hintId} className="text-sm leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      <div id={errorId} aria-live="polite">
        {error && (
          <p className="flex items-start gap-1.5 text-sm leading-5 font-medium text-danger">
            <CircleAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export { FormField };
