import { Database } from "bun:sqlite";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function sweepExpiredRooms(db: Database): number {
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const result = db.run(
    `DELETE FROM rooms WHERE status IN ('closed', 'expired') AND created_at < ?`,
    [cutoff],
  );
  return result.changes;
}

export function startCleanupInterval(db: Database): Timer {
  sweepExpiredRooms(db);
  const timer = setInterval(() => sweepExpiredRooms(db), CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}
