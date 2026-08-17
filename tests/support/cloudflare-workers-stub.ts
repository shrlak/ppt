// Stand-in for the `cloudflare:workers` module so worker/src/index.js can be
// imported by unit tests. Only the base class the Worker extends is needed —
// the storage itself is supplied by tests/support/workerHarness.ts.
export class DurableObject {
  readonly ctx: { storage: unknown };
  readonly env: Record<string, unknown>;

  constructor(ctx: { storage: unknown }, env: Record<string, unknown>) {
    this.ctx = ctx;
    this.env = env;
  }
}
