/**
 * Models intermittently confuse Serena's two symbol keys: pattern-key tools
 * (find_symbol, safe_delete_symbol) take `name_path_pattern`, while every other
 * name-bearing tool takes `name_path`. Normalise before schema validation.
 * No-op when the expected key is already present.
 */
export function repairSymbolNameKey(args: unknown, wantsPattern: boolean): any {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const a: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (wantsPattern) {
    if (a.name_path_pattern === undefined && a.name_path !== undefined) {
      a.name_path_pattern = a.name_path;
      delete a.name_path;
    }
  } else if (a.name_path === undefined && a.name_path_pattern !== undefined) {
    a.name_path = a.name_path_pattern;
    delete a.name_path_pattern;
  }
  return a;
}
