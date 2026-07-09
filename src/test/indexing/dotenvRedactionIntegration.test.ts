import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractLogicalUnitsFromFile } from '../../indexing/logicalUnitExtractor';
import { extractFacts } from '../../indexing/factExtractor';
import { astChunk } from '../../indexing/astChunker';
import { redactDotenvContent } from '../../indexing/dotenvRedactor';

// Security-review finding F2, integration level. `extractLogicalUnitsFromFile` does
// its OWN disk read internally (confirmed by direct reading of the function) --
// ExtractionCoordinator.extractFile() passes it a `content` argument that this
// legacy extractor never actually uses, so a caller-side-only redaction would NOT
// have protected this path. This test exercises the REAL function against a REAL
// temp file with realistic-length fake secrets, proving the redaction fix at the
// actual leak point (inside extractLogicalUnitsFromFile itself), not just at the
// pure redaction function in isolation.

const REALISTIC_ENV = `# Third-party API configuration
GEMINI_API_KEY=AIzaSyD1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P
GROQ_API_KEY="gsk_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcdEFGH"
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
DATABASE_URL=postgres://appuser:S3cretPass!23@localhost:5432/craftconnect
`;

const RAW_SECRET_VALUES = [
    'AIzaSyD1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P',
    'gsk_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcdEFGH',
    'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'S3cretPass!23'
];

async function makeTempWorkspace(filename: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repoguide-dotenv-redaction-'));
    await fs.writeFile(path.join(dir, filename), REALISTIC_ENV, 'utf8');
    return dir;
}

test('extractLogicalUnitsFromFile: a real .env.example file on disk never produces a logical unit carrying a raw secret value', async () => {
    const workspaceRoot = await makeTempWorkspace('.env.example');
    try {
        const units = await extractLogicalUnitsFromFile('.env.example', workspaceRoot);
        assert.ok(units.length > 0, 'expected at least one logical unit from the .env.example file (config_block)');

        const allUnitText = units.map(u => u.content).join('\n');
        for (const value of RAW_SECRET_VALUES) {
            assert.ok(!allUnitText.includes(value), `raw secret leaked into a LogicalUnit's content: ${value}`);
        }

        // Also check unit metadata (e.g. the regex-fallback config_block's
        // valuePreview) -- the earlier, unfixed leak point.
        const allMetadata = JSON.stringify(units.map(u => u.metadata));
        for (const value of RAW_SECRET_VALUES) {
            assert.ok(!allMetadata.includes(value), `raw secret leaked into LogicalUnit metadata: ${value}`);
        }

        // Structure must remain queryable: key names still present.
        assert.ok(allUnitText.includes('GEMINI_API_KEY'), 'key name lost');
        assert.ok(allUnitText.includes('AWS_SECRET_ACCESS_KEY'), 'key name lost');
        assert.ok(allUnitText.includes('[REDACTED]'), 'redaction placeholder must actually appear');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('extractFacts on the resulting .env.example logical units never carries a raw secret value (dotenv has no tree-sitter grammar, so this is trivially empty -- asserted explicitly, not assumed)', async () => {
    const workspaceRoot = await makeTempWorkspace('.env.example');
    try {
        const units = await extractLogicalUnitsFromFile('.env.example', workspaceRoot);
        const facts = units.flatMap(u => extractFacts(u));
        const allFactText = JSON.stringify(facts);
        for (const value of RAW_SECRET_VALUES) {
            assert.ok(!allFactText.includes(value), `raw secret leaked into an extracted fact: ${value}`);
        }
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('astChunk on redacted .env content (the real indexManager.ts call shape) never produces a chunk carrying a raw secret value', () => {
    // Mirrors indexManager.ts's real behavior: content is redacted BEFORE being
    // passed to astChunk() for embedding, since astChunk takes content directly
    // (no internal disk read of its own, unlike extractLogicalUnitsFromFile).
    const redactedContent = redactDotenvContent(REALISTIC_ENV);
    const chunks = astChunk('.env', redactedContent, 'dotenv');
    assert.ok(chunks.length > 0, 'expected at least one chunk from the redacted .env content');

    const allChunkText = chunks.map(c => c.text).join('\n');
    for (const value of RAW_SECRET_VALUES) {
        assert.ok(!allChunkText.includes(value), `raw secret present in a chunk that would be embedded: ${value}`);
    }
    assert.ok(allChunkText.includes('GEMINI_API_KEY'), 'key name lost -- file structure must remain queryable');
});

// Regression for the bare-.env role-classification gap discovered while writing the
// tests above: classifyFileRole() previously only recognized .env.example/.env.sample
// (the two literal CONFIG_FILENAMES entries) as role 'config' -- path.posix.extname
// returns '' for a leading-dot-only basename, so a bare .env fell through every role
// check to 'unknown', and extractUsefulNonSourceUnits() only builds units for role
// 'config'/'docs', returning [] for 'unknown'. Fixed in fileRoleClassifier.ts by
// recognizing the .env/.env.* basename convention generally (isDotenvBasename),
// matching the same convention languageDetector.ts already used for `language`.
test('extractLogicalUnitsFromFile: a bare .env file now produces logical units, same as .env.example (role-classification fix)', async () => {
    const workspaceRoot = await makeTempWorkspace('.env');
    try {
        const units = await extractLogicalUnitsFromFile('.env', workspaceRoot);
        assert.ok(units.length > 0, 'expected at least one logical unit from a bare .env file now that classifyFileRole recognizes it as role "config"');
        const allUnitText = units.map(u => u.content).join('\n');
        assert.ok(allUnitText.includes('GEMINI_API_KEY'), 'key name lost -- bare .env structure must be queryable, same as .env.example');
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});

// The critical check the role-classification fix must not regress: bare .env now
// reaches the SAME extractLogicalUnitsFromFile() code path as .env.example, which
// already redacts unconditionally based on `language === 'dotenv'` (set BEFORE any
// role-based branching) -- so this fix should inherit that protection automatically,
// not require a second redaction call site. Verified directly, not assumed.
test('extractLogicalUnitsFromFile: a bare .env file STILL never produces a logical unit carrying a raw secret value (F2 redaction must still apply to this newly-covered case)', async () => {
    const workspaceRoot = await makeTempWorkspace('.env');
    try {
        const units = await extractLogicalUnitsFromFile('.env', workspaceRoot);
        assert.ok(units.length > 0, 'expected units so this test actually exercises something (see the test above)');

        const allUnitText = units.map(u => u.content).join('\n');
        for (const value of RAW_SECRET_VALUES) {
            assert.ok(!allUnitText.includes(value), `role-classification fix reopened the F2 redaction gap -- raw secret leaked into a bare .env LogicalUnit's content: ${value}`);
        }

        const allMetadata = JSON.stringify(units.map(u => u.metadata));
        for (const value of RAW_SECRET_VALUES) {
            assert.ok(!allMetadata.includes(value), `role-classification fix reopened the F2 redaction gap -- raw secret leaked into bare .env LogicalUnit metadata: ${value}`);
        }

        assert.ok(allUnitText.includes('[REDACTED]'), 'redaction placeholder must actually appear for bare .env, same as .env.example');

        const facts = units.flatMap(u => extractFacts(u));
        const allFactText = JSON.stringify(facts);
        for (const value of RAW_SECRET_VALUES) {
            assert.ok(!allFactText.includes(value), `raw secret leaked into a fact extracted from a bare .env unit: ${value}`);
        }
    } finally {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
});
