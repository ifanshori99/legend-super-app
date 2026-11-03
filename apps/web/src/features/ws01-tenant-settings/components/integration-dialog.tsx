// Set up one integration (PRD v1.7 §3 F4 "Integrasi per Tenant"; PAY-06).
// Credentials are WRITE-ONLY: the stored values are never sent to the browser,
// so this form can only offer a blank "replace" set. What the user types goes
// straight into a one-shot buffer and the inputs are emptied before the request
// leaves, so no secret sits in component state, a query/mutation cache or the
// DOM once the save is sent.
import * as React from "react";
import { LockKeyhole } from "lucide-react";
import type { TenantIntegration } from "@starter/shared/platform";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { settingsErrorMessage } from "../errors";
import { useSaveIntegration } from "../hooks";
import {
  CREDENTIAL_MASK,
  buildUpsertInput,
  configDraftFor,
  hasReplacement,
  storedCredentialFields,
  validateIntegrationDraft,
  type ConfigDraft,
  type IntegrationErrors,
  type IntegrationScope,
  type ProviderDefinition,
} from "../integrations-lib";
import { createSecretBuffer } from "../secret-buffer";

export function IntegrationDialog({
  definition,
  row,
  scope,
  scopeLabel,
  open,
  onOpenChange,
}: {
  definition: ProviderDefinition;
  row: TenantIntegration | null;
  scope: IntegrationScope;
  scopeLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const save = useSaveIntegration();
  const buffer = React.useRef(createSecretBuffer());
  const [config, setConfig] = React.useState<ConfigDraft>(() =>
    configDraftFor(definition, row),
  );
  // Replacement credentials typed this session. Emptied on submit.
  const [replacement, setReplacement] = React.useState<Record<string, string>>(
    {},
  );
  const [errors, setErrors] = React.useState<IntegrationErrors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const stored = storedCredentialFields(row);

  // Leaving the dialog forgets anything typed or buffered.
  React.useEffect(() => {
    const held = buffer.current;
    return () => {
      held.take();
    };
  }, []);

  const close = (next: boolean) => {
    if (!next) {
      buffer.current.take();
      setReplacement({});
    }
    onOpenChange(next);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateIntegrationDraft(definition, config, replacement);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setServerError(null);
    const typed: Record<string, string> = {};
    for (const field of definition.credentials) {
      const value = replacement[field.name]?.trim();
      if (value) typed[field.name] = value;
    }
    if (hasReplacement(typed)) buffer.current.put(typed);
    // Wipe the inputs before the request leaves.
    setReplacement({});
    save.mutate(
      {
        input: buildUpsertInput(definition, scope, config, undefined),
        secrets: buffer.current,
      },
      {
        onSuccess: () => {
          toast({
            tone: "success",
            title: t("tenantSettings.integrations.saved", {
              name: t(definition.name),
            }),
          });
          onOpenChange(false);
        },
        onError: (failure) => setServerError(settingsErrorMessage(failure, t)),
      },
    );
  };

  const fieldError = (name: string) => {
    const key = errors[name];
    return key ? t(key) : undefined;
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(definition.name)}</DialogTitle>
          <DialogDescription>
            {t("tenantSettings.integrations.dialogScope", {
              scope: scopeLabel,
            })}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          {definition.config.map((field) => (
            <FormField
              key={field.name}
              label={t(field.label)}
              hint={field.hint ? t(field.hint) : undefined}
              error={fieldError(field.name)}
              required={field.required}
            >
              {field.kind === "select" ? (
                <Select
                  value={config[field.name] ?? ""}
                  onValueChange={(value) =>
                    setConfig((current) => ({
                      ...current,
                      [field.name]: value,
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options?.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {t(option.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={config[field.name] ?? ""}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  type={field.kind === "email" ? "email" : "text"}
                  inputMode={
                    field.kind === "whatsapp"
                      ? "tel"
                      : field.kind === "email"
                        ? "email"
                        : undefined
                  }
                  autoComplete="off"
                  maxLength={200}
                />
              )}
            </FormField>
          ))}

          <fieldset className="grid gap-3 rounded-container border-(length:--border-w) bg-surface-2 p-card">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold">
              <LockKeyhole className="size-4" aria-hidden="true" />
              {t("tenantSettings.integrations.credentialsTitle")}
            </legend>
            <p className="text-sm leading-5 text-muted-foreground">
              {stored.length > 0
                ? t("tenantSettings.integrations.credentialsStoredHint")
                : t("tenantSettings.integrations.credentialsNewHint")}
            </p>
            {stored.length > 0 && (
              <ul
                className="flex flex-wrap gap-2"
                aria-label={t("tenantSettings.integrations.storedFields")}
              >
                {stored.map((name) => {
                  const known = definition.credentials.find(
                    (field) => field.name === name,
                  );
                  return (
                    <li key={name}>
                      <Badge tone="success">
                        {known ? t(known.label) : name}
                        <span aria-hidden="true">{CREDENTIAL_MASK}</span>
                        <span className="sr-only">
                          {t("tenantSettings.integrations.storedSr")}
                        </span>
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
            {definition.credentials.map((field) => (
              <FormField
                key={field.name}
                label={
                  stored.length > 0
                    ? t("tenantSettings.integrations.replaceLabel", {
                        field: t(field.label),
                      })
                    : t(field.label)
                }
                error={fieldError(`credential:${field.name}`)}
              >
                <Input
                  type="password"
                  name={`credential-${field.name}`}
                  value={replacement[field.name] ?? ""}
                  onChange={(event) =>
                    setReplacement((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  autoComplete="new-password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={stored.length > 0 ? CREDENTIAL_MASK : undefined}
                  maxLength={4096}
                />
              </FormField>
            ))}
          </fieldset>

          {serverError && (
            <p
              role="alert"
              className="text-sm leading-5 font-medium text-danger"
            >
              {serverError}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
