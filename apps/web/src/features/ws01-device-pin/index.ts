// Public surface for POS / captain / KDS beads.
export { PinPad } from "./components/pin-pad.tsx";
export {
  OverrideRequestModal,
  type OverrideResult,
  type OverrideRequestModalProps,
} from "./components/override-request-modal.tsx";
export { SwitchUserScreen } from "./components/switch-user-screen.tsx";
export {
  useVerifyStaffPin,
  useCreateApprovalRequest,
  useApprovalRequestPolling,
} from "./hooks.ts";
export { useActiveStaff } from "./storage.ts";
export { usePinLock } from "./use-pin-lock.ts";
