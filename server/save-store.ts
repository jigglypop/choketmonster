import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type StoredSave = { save: unknown; revision: number; updatedAt: string };

export class SaveStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path = process.env.CHOKETMON_DB_PATH || resolve('data/local/server/choketmon.sqlite')) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS saves (
        profile_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        body TEXT NOT NULL,
        client_revision INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, slot)
      );
      DROP INDEX IF EXISTS saves_request;
      CREATE TABLE IF NOT EXISTS save_requests (
        profile_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        client_revision INTEGER NOT NULL,
        PRIMARY KEY (profile_id, request_id)
      );
    `);
  }

  get(profileId: string, slot: string): StoredSave | undefined {
    const row = this.db.prepare('SELECT body, client_revision, updated_at FROM saves WHERE profile_id = ? AND slot = ?')
      .get(profileId, slot) as { body: string; client_revision: number; updated_at: string } | undefined;
    return row ? { save: JSON.parse(row.body), revision: row.client_revision, updatedAt: row.updated_at } : undefined;
  }

  put(profileId: string, slot: string, save: unknown, revision: number, requestId: string): StoredSave {
    const body = JSON.stringify(save), updatedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.db.prepare('SELECT slot FROM save_requests WHERE profile_id = ? AND request_id = ?')
        .get(profileId, requestId) as { slot: string } | undefined;
      if (duplicate && duplicate.slot !== slot) throw new Error('Request ID was already used for another save slot');
      if (!duplicate) {
        const current = this.db.prepare('SELECT client_revision FROM saves WHERE profile_id = ? AND slot = ?')
          .get(profileId, slot) as { client_revision: number } | undefined;
        if (!current || revision > current.client_revision) {
          this.db.prepare(`INSERT INTO saves(profile_id, slot, body, client_revision, request_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(profile_id, slot) DO UPDATE SET body=excluded.body, client_revision=excluded.client_revision,
              request_id=excluded.request_id, updated_at=excluded.updated_at`)
            .run(profileId, slot, body, revision, requestId, updatedAt);
        }
        this.db.prepare('INSERT INTO save_requests(profile_id, request_id, slot, client_revision) VALUES (?, ?, ?, ?)')
          .run(profileId, requestId, slot, revision);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(profileId, slot)!;
  }

  close() { this.db.close(); }
}
