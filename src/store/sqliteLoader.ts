import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';

export type Database = DatabaseSync;

export function openDatabase(
  dbPath: string, 
  options?: { readonly?: boolean; [key: string]: any }
): DatabaseSync {
  const isReadOnly = options?.readonly === true;
  if (!isReadOnly && isZeroByteDatabase(dbPath)) {
    removeSqliteSidecars(dbPath);
  }
  try {
    return new DatabaseSync(dbPath, { open: true, readOnly: isReadOnly });
  } catch (error) {
    if (isReadOnly || !isRecoverableOpenError(error)) {
      throw error;
    }
    removeSqliteSidecars(dbPath);
    return new DatabaseSync(dbPath, { open: true, readOnly: isReadOnly });
  }
}

let savepointId = 0;

/**
 * Helper to replicate better-sqlite3's db.transaction(fn) behavior,
 * utilizing SAVEPOINTs to safely allow nested transactions.
 */
export function executeTransaction<T>(db: DatabaseSync, fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]): T => {
        const id = `tx_${++savepointId}`;
        db.exec(`SAVEPOINT ${id}`);
        try {
            const result = fn(...args);
            db.exec(`RELEASE SAVEPOINT ${id}`);
            return result;
        } catch (err) {
            db.exec(`ROLLBACK TO SAVEPOINT ${id}`);
            throw err;
        }
    };
}

function isZeroByteDatabase(dbPath: string): boolean {
    try {
        return fs.existsSync(dbPath) && fs.statSync(dbPath).size === 0;
    } catch {
        return false;
    }
}

function isRecoverableOpenError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /disk I\/O error/i.test(message);
}

function removeSqliteSidecars(dbPath: string): void {
    for (const suffix of ['-journal', '-wal', '-shm']) {
        try {
            fs.rmSync(`${dbPath}${suffix}`, { force: true });
        } catch {
            // Recovery is best-effort; the second open will surface persistent problems.
        }
    }
}
