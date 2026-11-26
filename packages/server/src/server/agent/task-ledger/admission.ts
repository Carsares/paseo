import { AsyncLocalStorage } from "node:async_hooks";
import { TaskDispatchRejectedError } from "./reuse.js";

export interface TaskDispatchAdmission {
  agentId?: string;
  messageId?: string;
  assertCurrent?: () => void;
  beforeProviderDispatch?: () => Promise<void>;
}

// The durable queue uses a different async caller when it drains. Delivery
// saves this scope on the single confirmed message and restores it there.
const admissions = new AsyncLocalStorage<TaskDispatchAdmission | undefined>();

export function runWithTaskDispatchAdmission<T>(
  admission: TaskDispatchAdmission | undefined,
  operation: () => T,
): T {
  return admissions.run(admission, operation);
}

export function currentTaskDispatchAdmission(messageId?: string) {
  const admission = admissions.getStore();
  return messageId && admission?.messageId === messageId ? admission : undefined;
}

export function attachTaskDispatchMessage(agentId: string, messageId: string) {
  const admission = admissions.getStore();
  if (!admission) return undefined;
  if (admission.agentId !== agentId || admission.messageId !== undefined) {
    throw new TaskDispatchRejectedError("Task dispatch does not own this queued message.");
  }
  admission.messageId = messageId;
  return admission;
}

export function assertTaskDispatchAdmission(admission: TaskDispatchAdmission, agentId: string) {
  if (admission.agentId !== agentId || !admission.assertCurrent) {
    throw new TaskDispatchRejectedError(
      "Task dispatch has no current authorization for this agent.",
    );
  }
  admission.assertCurrent();
}
