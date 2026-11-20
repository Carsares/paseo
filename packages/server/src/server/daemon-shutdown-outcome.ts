export class SavedRecoveryTerminalCleanupError extends Error {
  constructor(cause: unknown) {
    super("Agent recovery was saved but terminal cleanup failed", { cause });
    this.name = "SavedRecoveryTerminalCleanupError";
  }
}
