/**
 * pi-classifier ships plain JS with no types (pi-budget pattern). Declare only
 * what pi-plan imports so `tsc --noEmit` stays green.
 */
declare module "@bacnh85/pi-classifier" {
  export interface PlanGateVerdict {
    /** True only in enforce mode with a confident Jev yes — auto-allow the command. */
    allow: boolean;
    read_only?: number;
    serves_plan?: number;
    reason?: "disabled" | "risky" | "error";
  }
  export function planGateVerdict(
    opts: { signal?: AbortSignal },
    command: string,
    cwd: string,
    task?: string,
  ): Promise<PlanGateVerdict>;
}
