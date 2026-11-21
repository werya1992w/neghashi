import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 8;
const STALE_MS = 10 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genCode() {
  let s = "";
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

// فهرست اتاق‌های عمومی برای «بازی سریع». فقط یک نمونه (main) دارد.
export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS rooms (
         code TEXT PRIMARY KEY, count INTEGER NOT NULL, phase TEXT NOT NULL, updated INTEGER NOT NULL
       )`
    );
  }

  findOrCreate() {
    const now = Date.now();
    this.sql.exec("DELETE FROM rooms WHERE updated < ?", now - STALE_MS);
    const rows = this.sql
      .exec(
        "SELECT code FROM rooms WHERE count > 0 AND count < ? ORDER BY count DESC LIMIT 1",
        MAX_PLAYERS
      )
      .toArray();
    if (rows.length) return rows[0].code;
    const code = genCode();
    this.sql.exec("INSERT OR REPLACE INTO rooms VALUES (?, 0, 'lobby', ?)", code, now);
    return code;
  }

  report(code, count, phase) {
    if (count <= 0) {
      this.sql.exec("DELETE FROM rooms WHERE code = ?", code);
    } else {
      this.sql.exec(
        "INSERT OR REPLACE INTO rooms VALUES (?, ?, ?, ?)",
        code,
        count,
        phase,
        Date.now()
      );
    }
  }
}
