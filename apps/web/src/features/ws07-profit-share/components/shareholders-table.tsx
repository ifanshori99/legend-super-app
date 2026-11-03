// The shareholder register (PRD §3.37 "Daftar Pemegang Saham Berversi"). NPWP
// and account numbers travel masked from the API; the dialog writes plaintext
// once (create/update) and the read model never carries it.
import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import type { Shareholder } from "@starter/shared/accounting";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SHAREHOLDER_TYPE_KEYS, sortShareholders } from "../lib";
import { ShareholderStatusBadge } from "./share-status";

function matchesShareholder(
  shareholder: Pick<Shareholder, "name">,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase("id-ID");
  return (
    needle === "" ||
    shareholder.name.toLocaleLowerCase("id-ID").includes(needle)
  );
}

export function ShareholdersTable({
  shareholders,
  state,
  canWrite,
  onRetry,
  onCreate,
  onEdit,
}: {
  shareholders: readonly Shareholder[];
  state: DataState;
  canWrite: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onEdit: (shareholder: Shareholder) => void;
}) {
  const t = useT();
  const [search, setSearch] = React.useState("");
  const rows = React.useMemo(
    () => sortShareholders(shareholders),
    [shareholders],
  );
  const visible = rows.filter((row) => matchesShareholder(row, search));
  return (
    <DataTableShell
      title={t("accounting.share.shareholders.title")}
      description={t("accounting.share.shareholders.subtitle")}
      state={state}
      onRetry={onRetry}
      search={{
        value: search,
        onChange: setSearch,
        label: t("accounting.share.shareholders.search"),
      }}
      noResults={search.trim() !== "" && visible.length === 0}
      rowCount={rows.length}
      actions={
        canWrite ? (
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus aria-hidden="true" />
            {t("accounting.share.shareholders.add")}
          </Button>
        ) : undefined
      }
      empty={{
        title: t("accounting.share.shareholders.emptyTitle"),
        description: t("accounting.share.shareholders.emptyHint"),
        action: canWrite ? (
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus aria-hidden="true" />
            {t("accounting.share.shareholders.add")}
          </Button>
        ) : undefined,
      }}
    >
      <Table className="min-w-[48rem]">
        <TableHeader>
          <TableRow>
            <TableHead>
              {t("accounting.share.shareholders.columns.name")}
            </TableHead>
            <TableHead>
              {t("accounting.share.shareholders.columns.type")}
            </TableHead>
            <TableHead>
              {t("accounting.share.shareholders.columns.npwp")}
            </TableHead>
            <TableHead>
              {t("accounting.share.shareholders.columns.payout")}
            </TableHead>
            <TableHead>
              {t("accounting.share.shareholders.columns.status")}
            </TableHead>
            <TableHead className="text-right">
              {t("accounting.share.shareholders.columns.actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((shareholder) => (
            <TableRow key={shareholder.id}>
              <TableCell className="font-medium">{shareholder.name}</TableCell>
              <TableCell>
                {t(SHAREHOLDER_TYPE_KEYS[shareholder.type])}
              </TableCell>
              <TableCell className="tabular text-muted-foreground">
                {shareholder.npwpMasked ??
                  t("accounting.share.shareholders.noNpwp")}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {shareholder.payoutAccount ? (
                  <span className="tabular">
                    {shareholder.payoutAccount.bank}{" "}
                    {shareholder.payoutAccount.accountNumberMasked}
                    <span className="ml-1 text-sm">
                      · {shareholder.payoutAccount.accountHolder}
                    </span>
                  </span>
                ) : (
                  t("accounting.share.shareholders.noPayout")
                )}
              </TableCell>
              <TableCell>
                <ShareholderStatusBadge status={shareholder.status} />
              </TableCell>
              <TableCell className="text-right">
                {canWrite && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("accounting.share.shareholders.editAria", {
                      name: shareholder.name,
                    })}
                    onClick={() => onEdit(shareholder)}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
