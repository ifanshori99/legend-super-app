// Mock handler for the storage capabilities (VITE_API_MOCK=true). The mock has
// no PDF scanner, like a server without one.
import { getStorageCapabilities } from "@starter/shared/storage";
import { registerMock } from "@/lib/mock/registry";

registerMock(getStorageCapabilities, () => ({
  data: { documentsAccepted: false },
}));
