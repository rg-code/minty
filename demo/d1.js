// A D1Database for the live demo, over sql.js (SQLite compiled to WebAssembly) in the browser.
// Only what the Worker uses: prepare().bind().all() / first() / run() / raw(), and batch() as one
// transaction. Values are bound as D1 binds them (booleans as 1/0; undefined is refused).

const value = (v) => {
  if (v === undefined) throw new TypeError("D1_TYPE_ERROR: undefined can't be bound");
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
};

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params.map(value)); }

  /** Runs the statement now; rows as objects (or arrays with raw). */
  _exec(raw = false) {
    const stmt = this.db.sql.prepare(this.sql);
    try {
      stmt.bind(this.params);
      const rows = [];
      while (stmt.step()) rows.push(raw ? stmt.get() : stmt.getAsObject());
      const changes = this.db.sql.getRowsModified();
      return { rows, columns: stmt.getColumnNames(), changes };
    } finally {
      stmt.free();
    }
  }
  _result() {
    const { rows, changes } = this._exec();
    const last = this.db.sql.exec("SELECT last_insert_rowid()")[0]?.values[0][0] ?? 0;
    return { success: true, results: rows, meta: { changes, last_row_id: last, rows_read: 0, rows_written: changes, duration: 0 } };
  }

  async all() { return this._result(); }
  async run() { return this._result(); }
  async first(column) {
    const row = this._exec().rows[0] ?? null;
    return column === undefined || row === null ? row : row[column] ?? null;
  }
  async raw(opts = {}) {
    const { rows, columns } = this._exec(true);
    return opts.columnNames ? [columns, ...rows] : rows;
  }
}

export class DemoD1 {
  constructor(sql) { this.sql = sql; }
  prepare(query) { return new Statement(this, query); }
  async batch(statements) {
    this.sql.run("BEGIN");
    try {
      const out = statements.map((s) => s._result());
      this.sql.run("COMMIT");
      return out;
    } catch (e) {
      this.sql.run("ROLLBACK");
      throw e;
    }
  }
  async exec(query) { this.sql.exec(query); return { count: 1, duration: 0 }; }
}
