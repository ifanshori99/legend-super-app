import { useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { endActingStaffMode } from "@/lib/api/acting-staff";
import { revokePushOnSignOut } from "@/features/ws05-notifications/revoke";
import { clearPosShell } from "@/features/ws04-pos-kasir/offline/shell";
import { countPendingOfflineSales } from "@/features/ws04-pos-kasir/offline/queue";
import { defaultOfflineBackend } from "@/features/ws04-pos-kasir/offline/store";
import { SignOutBlockedDialog } from "@/features/ws04-pos-kasir/offline/sign-out-blocked-dialog";
import { Button } from "@/components/ui/button";
import { clearRetainedAttempt } from "@/lib/retained-attempt-key";
import { hrisKeys } from "@/features/ws10-hris-employee/queries";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  // Review O3 P2 3: offline sales still on this tablet block the sign-out.
  const [unsent, setUnsent] = useState(0);
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  async function signOut() {
    setPending(true);
    setError(false);
    setUnsent(0);
    try {
      // Review O3 P2 3: offline sales still on this tablet (unsent or waiting
      // on a conflict report) would be stranded by a new login. Unreadable
      // storage holds none this button can protect, so it does not block.
      const held = await countPendingOfflineSales(
        defaultOfflineBackend(),
        null,
      ).catch(() => 0);
      if (held > 0) {
        setUnsent(held);
        return;
      }
      // While the session still exists: drop this browser's alarm push
      // subscription so the next person here does not receive it. Best-effort.
      await revokePushOnSignOut();
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out failed");
      // The POS cashier hold belongs to this login; the next one starts clean.
      endActingStaffMode();
      // Idempotency attempts kept for dialogs belong to this login.
      clearRetainedAttempt();
      // O3: the /pos pages cached for offline belong to this login.
      await clearPosShell();
      // The next account on this tab must not see the employee data cached
      // for this one (profile, history, corrections).
      queryClient.removeQueries({ queryKey: hrisKeys.all });
      await router.invalidate();
      await navigate({ to: "/sign-in", replace: true });
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SignOutBlockedDialog
        unsent={unsent}
        onClose={() => setUnsent(0)}
        onOpenCashier={() => {
          setUnsent(0);
          void navigate({ to: "/pos/kasir" });
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t sign out. Try again.
        </p>
      )}
      <Button onClick={signOut} disabled={pending} variant="outline" size="sm">
        <LogOut aria-hidden="true" />
        {pending ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
