import { cn } from "cn";
import { OfflineBannerSlot } from "@/components/layout/offline-banner-slot";
// Imported from the file, not the "../recovery" barrel: the barrel pulls in
// pages that import qr-primitives (QrTopBar renders these notices), a cycle.
import { IssuePrompt } from "../recovery/issue-prompt";

/**
 * The offline banner and the failed-item prompt. Rendered right under each
 * page's top layer (QrTopBar or the menu header) so they never sit above it.
 */
export function QrFrameNotices({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-3 empty:hidden", className)}>
      <OfflineBannerSlot />
      <IssuePrompt />
    </div>
  );
}
