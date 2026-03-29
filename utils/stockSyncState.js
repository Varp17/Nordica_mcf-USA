/**
 * Shared stock sync state
 * ────────────────────────
 * Simple in-memory store for the last sync timestamp.
 * Used by both the stock API route and the inventorySync job
 * WITHOUT creating a circular import dependency.
 */

let _lastSyncedAt = null;

export function setLastSyncedAt(ts) {
  _lastSyncedAt = ts;
}

export function getLastSyncedAt() {
  return _lastSyncedAt;
}
