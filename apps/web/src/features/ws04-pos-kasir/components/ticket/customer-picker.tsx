import { useId, useState } from "react";
import { Check } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CUSTOMER_SEARCH_MIN_CHARS,
  useTicketReady,
  useTicketCustomerSearch,
} from "../../ticket/hooks";
import type { TicketCustomer } from "../../ticket/types";
import { Notice, PosPanel } from "../shared";
import { TicketError } from "./ticket-error";

// Step 2: find the customer by name. The ticket is issued to the profile the
// cashier picks; the server resolves the tenant and checks the profile.
export function CustomerPicker({
  selected,
  disabled,
  onSelect,
  onClear,
}: {
  selected: TicketCustomer | null;
  disabled?: boolean;
  onSelect: (customer: TicketCustomer) => void;
  onClear: () => void;
}) {
  const t = useT();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const [text, setText] = useState("");
  const ready = useTicketReady();
  const search = useTicketCustomerSearch(text);
  const searching = text.trim().length >= CUSTOMER_SEARCH_MIN_CHARS;
  const results = search.data ?? [];

  return (
    <PosPanel title={t("posKasirTicket.customer.title")}>
      {selected ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-(length:--density-text) font-semibold">
            <Check className="size-5 text-success" aria-hidden="true" />
            {t("posKasirTicket.customer.selected", { name: selected.name })}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={onClear}
          >
            {t("posKasirTicket.customer.change")}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={inputId}>
              {t("posKasirTicket.customer.label")}
            </Label>
            <Input
              id={inputId}
              type="search"
              autoComplete="off"
              value={text}
              disabled={disabled}
              placeholder={t("posKasirTicket.customer.placeholder")}
              aria-describedby={hintId}
              onChange={(event) => setText(event.target.value)}
            />
            <p id={hintId} className="text-sm text-muted-foreground">
              {t("posKasirTicket.customer.hint")}
            </p>
          </div>
          {searching && !ready ? (
            <Notice tone="info" title={t("posKasirTicket.customer.noOutlet")}>
              {t("posKasirTicket.customer.noOutletHint")}
            </Notice>
          ) : searching && search.isFetching ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("posKasirTicket.customer.searching")}
            </p>
          ) : searching && search.isError ? (
            <TicketError
              error={search.error}
              title={t("posKasirTicket.customer.errorTitle")}
              onRetry={() => void search.refetch()}
            />
          ) : searching && search.isSuccess && results.length === 0 ? (
            <Notice tone="info" title={t("posKasirTicket.customer.empty")}>
              {t("posKasirTicket.customer.emptyHint")}
            </Notice>
          ) : searching && results.length > 0 ? (
            <ul className="grid gap-2">
              {results.map((customer) => (
                <li key={customer.id}>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    aria-label={t("posKasirTicket.customer.pick", {
                      name: customer.name,
                    })}
                    className="w-full justify-start"
                    onClick={() => onSelect(customer)}
                  >
                    {customer.name}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </PosPanel>
  );
}
