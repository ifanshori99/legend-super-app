// FAILOVER_OPEN_WORK with the list of what still blocks a failover return or
// cancel (1271 F3). Kept apart from the service so the error handler can read
// it without loading the database layer.
import type { FailoverOpenWork } from "@starter/shared/edge";
import { PosError } from "@starter/shared/pos";

export class FailoverOpenWorkError extends PosError {
  readonly openWork: FailoverOpenWork;
  constructor(openWork: FailoverOpenWork) {
    super("FAILOVER_OPEN_WORK");
    this.openWork = openWork;
  }
}
