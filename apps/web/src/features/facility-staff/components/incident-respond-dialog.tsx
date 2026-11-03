// Acknowledge one incident with the action taken (FAC-08). The resolution is
// required by `respondFacilityIncidentSchema` (3–500 characters), so the dialog
// validates before sending and shows the API's error next to the field when the
// request fails.
import * as React from "react";
import { useT } from "@/components/i18n";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import type { FacilityIncident } from "@starter/shared/facility";
import { useRespondFacilityIncident } from "../hooks.ts";
import { INCIDENT_TYPE_KEYS } from "../view.ts";

export function IncidentRespondDialog({
  incident,
  unitLabel,
  onClose,
}: {
  incident: FacilityIncident | null;
  unitLabel: string;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const respond = useRespondFacilityIncident();
  const [resolution, setResolution] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const submit = () => {
    if (!incident) return;
    const trimmed = resolution.trim();
    if (trimmed.length < 3) {
      setError(t("facilityStaff.incident.resolutionTooShort"));
      return;
    }
    setError(null);
    respond.mutate(
      { incidentId: incident.id, body: { resolution: trimmed } },
      {
        onSuccess: () => {
          toast({
            title: t("facilityStaff.incident.respondDone"),
            tone: "success",
          });
          onClose();
        },
        onError: (caught) => setError(caught.message),
      },
    );
  };

  return (
    <Dialog
      open={incident !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-slot="incident-respond-dialog">
        <DialogHeader>
          <DialogTitle>{t("facilityStaff.incident.respondTitle")}</DialogTitle>
          <DialogDescription>
            {incident
              ? t("facilityStaff.incident.respondContext", {
                  unit: unitLabel,
                  type: t(INCIDENT_TYPE_KEYS[incident.type]),
                })
              : t("facilityStaff.incident.respondHint")}
          </DialogDescription>
        </DialogHeader>
        <FormField
          label={t("facilityStaff.incident.resolutionLabel")}
          hint={t("facilityStaff.incident.respondHint")}
          error={error ?? undefined}
          required
        >
          <Textarea
            value={resolution}
            maxLength={500}
            placeholder={t("facilityStaff.incident.resolutionPlaceholder")}
            onChange={(event) => setResolution(event.target.value)}
          />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" loading={respond.isPending} onClick={submit}>
            {t("facilityStaff.incident.respondSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
