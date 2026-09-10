// Cron schedule math on top of cron-parser (v5, ESM). One file so the
// dependency can be swapped for a hand-rolled matcher without touching callers.
import { CronExpressionParser } from "cron-parser";

export function validateSchedule(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return "expected 5 fields (minute hour day-of-month month day-of-week), e.g. '0 9 * * mon'";
  }
  try {
    // .next() is the real validator — bare parse() accepts out-of-range values.
    CronExpressionParser.parse(expr).next();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function nextFire(expr: string, from: Date): Date | null {
  try {
    return CronExpressionParser.parse(expr, { currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

export function nextFires(expr: string, n: number, from: Date): Date[] {
  const out: Date[] = [];
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: from });
    for (let i = 0; i < n; i++) out.push(it.next().toDate());
  } catch {
    // Invalid expression — callers validate first; return what we have.
  }
  return out;
}
