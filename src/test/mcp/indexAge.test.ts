import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeIndexAge } from '../../mcp/indexAge';

// Real files with a controlled mtime (fs.utimesSync), not a mocked fs module --
// this is a deterministic stat-and-compare, so testing it against the real
// filesystem is cheap and matches this repo's stated preference for real data.

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-indexage-'));
}

test('reflects the real manifest.json mtime as lastIndexedAt and a matching ageSeconds', () => {
    const dir = makeTempDir();
    try {
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, '{}', 'utf8');
        const mtime = new Date('2026-01-01T00:00:00.000Z');
        fs.utimesSync(manifestPath, mtime, mtime);

        const now = mtime.getTime() + 90_000; // 90s later
        const info = computeIndexAge(dir, now);

        assert.ok(info);
        assert.equal(info!.lastIndexedAt, mtime.toISOString());
        assert.equal(info!.ageSeconds, 90);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a manifest that does not exist yet (never indexed) returns null, not a thrown error', () => {
    const dir = makeTempDir();
    try {
        const info = computeIndexAge(dir, Date.now());
        assert.equal(info, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a just-written manifest (reindex happened moments ago) reports ageSeconds near zero', () => {
    const dir = makeTempDir();
    try {
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, '{}', 'utf8');
        const stat = fs.statSync(manifestPath);

        const info = computeIndexAge(dir, stat.mtimeMs + 500);
        assert.ok(info);
        assert.equal(info!.ageSeconds, 1); // rounds 0.5s up to 1
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('never reports a negative age even if the clock reading is fractionally behind the mtime (rounding edge)', () => {
    const dir = makeTempDir();
    try {
        const manifestPath = path.join(dir, 'manifest.json');
        fs.writeFileSync(manifestPath, '{}', 'utf8');
        const stat = fs.statSync(manifestPath);

        const info = computeIndexAge(dir, stat.mtimeMs - 10);
        assert.ok(info);
        assert.equal(info!.ageSeconds, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
