import test from 'node:test';
import * as assert from 'node:assert/strict';
import { isWalkableFile, ALLOWED_EXTENSIONS } from '../../indexing/fileWalker';
import { detectLanguage } from '../../indexing/languageDetector';

// Found via a real capability audit against CraftConnect: a real Dockerfile and
// deployment/cloud_run_config.yaml existed on disk but had ZERO manifest entries
// (confirmed directly against the live index), because neither ALLOWED_EXTENSIONS
// nor detectLanguage() recognized them -- any deployment/infra question was
// structurally unanswerable, not a retrieval-tuning gap.

test('isWalkableFile: recognizes .yaml/.yml by extension', () => {
    assert.equal(isWalkableFile('deployment/cloud_run_config.yaml'), true);
    assert.equal(isWalkableFile('docker-compose.yml'), true);
    assert.equal(isWalkableFile('.github/workflows/ci.yaml'), true);
});

test('isWalkableFile: recognizes bare Dockerfile and its dotted variants', () => {
    assert.equal(isWalkableFile('Dockerfile'), true);
    assert.equal(isWalkableFile('dockerfile'), true); // case-insensitive
    assert.equal(isWalkableFile('backend/Dockerfile'), true);
    assert.equal(isWalkableFile('Dockerfile.dev'), true);
    assert.equal(isWalkableFile('Dockerfile.prod'), true);
});

test('isWalkableFile: recognizes bare Makefile', () => {
    assert.equal(isWalkableFile('Makefile'), true);
    assert.equal(isWalkableFile('makefile'), true);
});

test('isWalkableFile: recognizes .env and its variants', () => {
    assert.equal(isWalkableFile('.env'), true);
    assert.equal(isWalkableFile('.env.example'), true);
    assert.equal(isWalkableFile('.env.production'), true);
});

test('isWalkableFile: does not accidentally widen matching to unrelated files', () => {
    assert.equal(isWalkableFile('README.txt'), false);
    assert.equal(isWalkableFile('data.json'), false);
    // Named suggestively but must NOT match via prefix/basename confusion --
    // "notdockerfile" does not start with "dockerfile", and a plain .env-less
    // "environment.txt" is not the ".env" dotfile convention.
    assert.equal(isWalkableFile('notdockerfile.txt'), false);
    assert.equal(isWalkableFile('environment.txt'), false);
});

test('ALLOWED_EXTENSIONS still contains every previously-supported extension (no regression)', () => {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.kt', '.rb', '.cs', '.php', '.swift', '.md']) {
        assert.ok(ALLOWED_EXTENSIONS.has(ext), `expected ${ext} to remain in ALLOWED_EXTENSIONS`);
    }
});

test('detectLanguage: recognizes the new infra file conventions, falling back to plain-text chunking (no tree-sitter grammar, same as Ruby/PHP/Swift)', () => {
    assert.equal(detectLanguage('Dockerfile'), 'dockerfile');
    assert.equal(detectLanguage('backend/Dockerfile.dev'), 'dockerfile');
    assert.equal(detectLanguage('Makefile'), 'makefile');
    assert.equal(detectLanguage('.env'), 'dotenv');
    assert.equal(detectLanguage('.env.example'), 'dotenv');
    assert.equal(detectLanguage('deployment/cloud_run_config.yaml'), 'yaml');
    assert.equal(detectLanguage('docker-compose.yml'), 'yaml');
});

test('detectLanguage: existing language detection is unaffected', () => {
    assert.equal(detectLanguage('src/index.ts'), 'typescript');
    assert.equal(detectLanguage('app/main.py'), 'python');
    assert.equal(detectLanguage('README.md'), 'markdown');
    assert.equal(detectLanguage('unknownfile.xyz'), null);
});
