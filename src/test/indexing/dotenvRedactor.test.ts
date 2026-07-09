import test from 'node:test';
import * as assert from 'node:assert/strict';
import { isDotenvFile, redactDotenvContent } from '../../indexing/dotenvRedactor';

// Security-review finding F2: CraftConnect's own .env had real API keys, and nothing
// stops a Marketplace user's repo from having the same -- these tests use
// realistic-length fake secret values (real key formats, real lengths) to prove no
// raw value survives redaction, while key names and file structure remain intact.

const REALISTIC_ENV = `# Third-party API configuration
GEMINI_API_KEY=AIzaSyD1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P
GROQ_API_KEY="gsk_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcdEFGH"
export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# Local dev server settings
PORT=8080
DEBUG=true
DATABASE_URL=postgres://appuser:S3cretPass!23@localhost:5432/craftconnect

# Base64 values can contain '=' padding -- must not truncate at the first internal '='
ENCODED_SECRET=YWJjMTIzZGVmNDU2Z2hpNzg5PT0=
`;

test('redactDotenvContent: no raw secret value survives anywhere in the output', () => {
    const redacted = redactDotenvContent(REALISTIC_ENV);
    const rawValues = [
        'AIzaSyD1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P',
        'gsk_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcdEFGH',
        'AKIAIOSFODNN7EXAMPLE',
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'S3cretPass!23',
        'postgres://appuser:S3cretPass!23@localhost:5432/craftconnect',
        'YWJjMTIzZGVmNDU2Z2hpNzg5PT0='
    ];
    for (const value of rawValues) {
        assert.ok(!redacted.includes(value), `raw value leaked into redacted output: ${value}`);
    }
});

test('redactDotenvContent: key names and file structure remain intact and queryable', () => {
    const redacted = redactDotenvContent(REALISTIC_ENV);
    for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'PORT', 'DEBUG', 'DATABASE_URL', 'ENCODED_SECRET']) {
        assert.ok(redacted.includes(key), `key name lost during redaction: ${key}`);
    }
    assert.ok(redacted.includes('# Third-party API configuration'), 'comment lost');
    assert.ok(redacted.includes('# Local dev server settings'), 'comment lost');
    assert.equal(redacted.split('\n').length, REALISTIC_ENV.split('\n').length, 'line count/structure must be preserved');
});

test('redactDotenvContent: every assignment line is replaced with the fixed placeholder', () => {
    const redacted = redactDotenvContent(REALISTIC_ENV);
    assert.ok(redacted.includes('GEMINI_API_KEY=[REDACTED]'));
    assert.ok(redacted.includes('GROQ_API_KEY=[REDACTED]'), 'quoted value must also be fully redacted');
    assert.ok(redacted.includes('export AWS_ACCESS_KEY_ID=[REDACTED]'), 'export prefix must be preserved, value redacted');
    assert.ok(redacted.includes('PORT=[REDACTED]'), 'non-secret-looking values are redacted too (blanket policy, not shape-based)');
    assert.ok(redacted.includes('ENCODED_SECRET=[REDACTED]'), 'value containing internal "=" must be fully redacted, not split at the wrong "="');
});

test('redactDotenvContent: KEY: VALUE colon syntax is also redacted', () => {
    const content = 'api_token: sk-live-abcdefghijklmnopqrstuvwxyz123456\nregion: us-east-1';
    const redacted = redactDotenvContent(content);
    assert.ok(!redacted.includes('sk-live-abcdefghijklmnopqrstuvwxyz123456'));
    assert.equal(redacted, 'api_token: [REDACTED]\nregion: [REDACTED]');
});

test('redactDotenvContent: blank lines and comment-only lines are preserved byte-for-byte', () => {
    const content = '# header comment\n\nKEY=secretvalue\n\n# trailing comment';
    const redacted = redactDotenvContent(content);
    assert.equal(redacted, '# header comment\n\nKEY=[REDACTED]\n\n# trailing comment');
});

test('redactDotenvContent: an empty file redacts to itself (no crash on edge input)', () => {
    assert.equal(redactDotenvContent(''), '');
});

test('isDotenvFile: recognizes .env and its dotted variants, rejects unrelated files', () => {
    assert.equal(isDotenvFile('.env'), true);
    assert.equal(isDotenvFile('.env.local'), true);
    assert.equal(isDotenvFile('.env.production'), true);
    assert.equal(isDotenvFile('config/.env'), true);
    assert.equal(isDotenvFile('src/index.ts'), false);
    assert.equal(isDotenvFile('environment.txt'), false);
    assert.equal(isDotenvFile('README.md'), false);
});
