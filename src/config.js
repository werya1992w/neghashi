import { DurableObject } from "cloudflare:workers";

// فهرست کلمات سفارشی بازی. تا وقتی ادمین چیزی ذخیره نکرده، بازی از words.js استفاده می‌کند.
export class Config extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS words (id INTEGER PRIMARY KEY AUTOINCREMENT, w TEXT NOT NULL UNIQUE)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  }

  getWords() {
    const custom = this.sql.exec("SELECT v FROM meta WHERE k = 'custom'").toArray().length > 0;
    if (!custom) return { custom: false, words: [] };
    const words = this.sql.exec("SELECT w FROM words ORDER BY id").toArray().map((r) => r.w);
    return { custom: true, words };
  }

  setWords(list) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM words");
      for (const w of list) this.sql.exec("INSERT OR IGNORE INTO words (w) VALUES (?)", w);
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('custom', '1')");
    });
  }

  reset() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM words");
      this.sql.exec("DELETE FROM meta WHERE k = 'custom'");
    });
  }
}
