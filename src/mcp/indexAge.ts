import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic mtime check on the index manifest -- a stat plus a
 * subtraction, no inference involved. The MCP server (mcpServer.ts) loads
 * every store once at startup with no live reindex path (see README.md's
 * MCP section), so an agent consuming MCP results mid-coding-session has no
 * other signal for how stale those results might be relative to edits made
 * since the server started. Computed fresh per tool call, not cached at
 * startup, so it reflects a reindex that happened (and a server restart
 * that picked it up) partway through a session.
 */
export interface IndexAgeInfo {
    lastIndexedAt: string;
    ageSeconds: number;
}

export function computeIndexAge(repoguideDir: string, now: number = Date.now()): IndexAgeInfo | null {
    const manifestPath = path.join(repoguideDir, 'manifest.json');
    let stat: fs.Stats;
    try {
        stat = fs.statSync(manifestPath);
    } catch {
        return null;
    }
    return {
        lastIndexedAt: new Date(stat.mtimeMs).toISOString(),
        ageSeconds: Math.max(0, Math.round((now - stat.mtimeMs) / 1000))
    };
}
