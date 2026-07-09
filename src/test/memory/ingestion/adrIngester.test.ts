import test from 'node:test';
import * as assert from 'node:assert/strict';
import { isAdrFilePath } from '../../../memory/ingestion/adrIngester';

// Security review finding F1: constructing an AdrIngester (via indexManager.ts's
// getAdrIngester()) transitively initializes LocalEmbeddingProvider, which downloads
// a model from huggingface.co on first use -- effectively unconditional, since
// indexManager.ts used to await getAdrIngester() BEFORE checking whether the current
// file was even an ADR, firing on the first file of every indexing run regardless of
// type. Fixed by checking isAdrFilePath() first at all 4 call sites in
// indexManager.ts, only constructing the ingester when it's actually needed.
// isAdrFilePath was extracted to a standalone, dependency-free function specifically
// so callers (and this test) don't need to construct an AdrIngester (or its
// MemoryIngestionPipeline dependency chain) just to answer "is this file an ADR".

test('isAdrFilePath: recognizes real ADR path conventions', () => {
    assert.equal(isAdrFilePath('/repo/docs/adr/0001-use-postgres.md', '/repo'), true);
    assert.equal(isAdrFilePath('/repo/docs/adrs/0001-use-postgres.md', '/repo'), true);
    assert.equal(isAdrFilePath('/repo/adr/0001-use-postgres.md', '/repo'), true);
    assert.equal(isAdrFilePath('/repo/adrs/0001-use-postgres.md', '/repo'), true);
    assert.equal(isAdrFilePath('/repo/architecture/decisions/0001-use-postgres.md', '/repo'), true);
});

test('isAdrFilePath: an ordinary source file is not an ADR', () => {
    assert.equal(isAdrFilePath('/repo/app/agents/mission_coordinator.py', '/repo'), false);
    assert.equal(isAdrFilePath('/repo/src/index.ts', '/repo'), false);
});

test('isAdrFilePath: a .env file is not an ADR (the exact case that made the old unconditional-await bug hit on the very first indexed file)', () => {
    assert.equal(isAdrFilePath('/repo/.env', '/repo'), false);
    assert.equal(isAdrFilePath('/repo/.env.example', '/repo'), false);
});

test('isAdrFilePath: a markdown file OUTSIDE an adr-named directory is not an ADR', () => {
    assert.equal(isAdrFilePath('/repo/README.md', '/repo'), false);
    assert.equal(isAdrFilePath('/repo/docs/guide.md', '/repo'), false);
});

test('isAdrFilePath: a non-.md file inside an adr-named directory is still not an ADR', () => {
    assert.equal(isAdrFilePath('/repo/docs/adr/notes.txt', '/repo'), false);
});

/**
 * Mirrors the EXACT gating shape now used at all 4 call sites in indexManager.ts:
 *   if (isAdrFilePath(filePath, workspaceRoot)) { await getAdrIngester(); ... }
 * Uses the real isAdrFilePath() (not a mock) with a spy standing in for
 * getAdrIngester(), to directly verify the call-count behavior the security fix
 * requires: constructing the ingester (the expensive, download-triggering step)
 * must be skipped entirely for a non-ADR file, and happen exactly once for an ADR
 * file. indexManager.ts's own constructor is not exercised here (too heavy --
 * requires vscode-backed StatusBarManager/RepositoryContext) so this isolates the
 * decision logic, which is the actual security-relevant behavior.
 */
async function simulateGatedIngesterCall(filePath: string, workspaceRoot: string, getAdrIngesterSpy: () => Promise<{ calls: number }>): Promise<void> {
    if (isAdrFilePath(filePath, workspaceRoot)) {
        await getAdrIngesterSpy();
    }
}

test('gated call pattern: getAdrIngester is NOT called for a non-ADR file', async () => {
    let calls = 0;
    const spy = async () => { calls++; return { calls }; };
    await simulateGatedIngesterCall('/repo/.env', '/repo', spy);
    await simulateGatedIngesterCall('/repo/app/main.py', '/repo', spy);
    assert.equal(calls, 0, 'getAdrIngester must not be constructed for non-ADR files');
});

test('gated call pattern: getAdrIngester IS called exactly once for an ADR file', async () => {
    let calls = 0;
    const spy = async () => { calls++; return { calls }; };
    await simulateGatedIngesterCall('/repo/docs/adr/0001-use-postgres.md', '/repo', spy);
    assert.equal(calls, 1, 'getAdrIngester must be constructed for an ADR file');
});

test('gated call pattern: a mixed batch only constructs the ingester for the ADR files in it', async () => {
    let calls = 0;
    const spy = async () => { calls++; return { calls }; };
    const files = ['/repo/.env', '/repo/src/index.ts', '/repo/docs/adr/0001.md', '/repo/README.md', '/repo/docs/adrs/0002.md'];
    for (const f of files) {
        await simulateGatedIngesterCall(f, '/repo', spy);
    }
    assert.equal(calls, 2, 'exactly the 2 real ADR files in this batch should have triggered ingester construction');
});
