export declare class FreeCastStore {
  constructor(ctx: { storage: unknown }, env: Record<string, unknown>);
  sessionUser(request: Request): string | null;
  fetch(request: Request): Promise<Response>;
}
export declare function handleFreecast(request: Request, env: Record<string, unknown>, headers: Record<string, string>): Promise<Response>;
