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
import { Button } from "@/components/ui/button";
import { clearRetainedAttempt } from "@/lib/retained-attempt-key";
import { hrisKeys } from "@/features/ws10-hris-employee/queries";

export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  async function signOut() {
    setPending(true);
    setError(null);
    try {
      // Review O3 P2 3: offline sales still on this tablet (unsent or waiting
      // on a conflict report) would be stranded by a new login. Unreadable
      // storage holds none this button can protect, so it does not block.
      const unsent = await countPendingOfflineSales(
        defaultOfflineBackend(),
        null,
      ).catch(() => 0);
      if (unsent > 0) {
        setError(
          `${unsent} offline sale${unsent === 1 ? " is" : "s are"} not sent yet. Connect to the internet and wait before signing out.`,
        );
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
      setError("Couldn’t sign out. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button onClick={signOut} disabled={pending} variant="outline" size="sm">
        <LogOut aria-hidden="true" />
        {pending ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
