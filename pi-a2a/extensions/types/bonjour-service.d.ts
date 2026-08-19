/**
 * Ambient module shim for the optional `bonjour-service` dependency.
 *
 * The package is dynamically imported at runtime (lib/mdns.ts) with graceful
 * degrade when absent. This declaration lets `tsc --noEmit` pass without the
 * package installed. When the consumer installs bonjour-service, its own
 * bundled types take precedence (TypeScript prefers the real .d.ts).
 */
declare module "bonjour-service" {
  export interface BonjourService {
    name?: string;
    host?: string;
    port?: number;
    txt?: Record<string, string>;
    referer?: { address?: string };
  }
  export class Bonjour {
    publish(opts: any): { start(cb?: (e?: Error) => void): void; stop(cb?: (e?: Error) => void): void };
    find(opts: any): { on(ev: "up" | "down", cb: (svc: BonjourService) => void): void; stop(): void };
    destroy(): Promise<void> | void;
  }
}
