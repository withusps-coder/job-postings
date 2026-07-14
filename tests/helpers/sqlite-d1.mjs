import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(
  new URL("../../migrations/0001_careers_mvp.sql", import.meta.url),
  "utf8",
);

/**
 * Minimal D1-compatible adapter backed by SQLite. It executes the production
 * migration, wraps batches in an SQLite transaction, and preserves primary
 * session reads on the same database connection.
 */
export class SqliteD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec(migration);
    /** @type {string[]} */
    this.sessions = [];
  }

  /** @param {string} constraint */
  withSession(constraint) {
    this.sessions.push(constraint);
    return this;
  }

  /** @param {string} sql */
  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  /** @param {SqliteD1Statement[]} statements */
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * @param {string} sql
   * @param {readonly import("node:sqlite").SQLInputValue[]} [parameters]
   */
  run(sql, parameters = []) {
    return this.database.prepare(sql).run(...parameters);
  }

  /**
   * @param {string} sql
   * @param {readonly import("node:sqlite").SQLInputValue[]} [parameters]
   * @returns {Record<string, unknown> | null}
   */
  one(sql, parameters = []) {
    const row = this.database.prepare(sql).get(...parameters);
    return row === undefined ? null : { ...row };
  }

  close() {
    this.database.close();
  }
}

class SqliteD1Statement {
  /**
   * @param {DatabaseSync} database
   * @param {string} sql
   */
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    /** @type {import("node:sqlite").SQLInputValue[]} */
    this.parameters = [];
  }

  /** @param {...import("node:sqlite").SQLInputValue} parameters */
  bind(...parameters) {
    this.parameters = parameters;
    return this;
  }

  async run() {
    return this.execute();
  }

  async first() {
    const row = this.database.prepare(this.sql).get(...this.parameters);
    return row === undefined ? null : { ...row };
  }

  async all() {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...this.parameters)
        .map((row) => ({ ...row })),
    };
  }

  execute() {
    return this.database.prepare(this.sql).run(...this.parameters);
  }
}

/** @param {SqliteD1} database */
export function asD1(database) {
  return /** @type {D1Database} */ (/** @type {unknown} */ (database));
}
