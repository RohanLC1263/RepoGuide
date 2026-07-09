import test from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyFileRole, isImplementationFile, isTestFile } from '../indexing/fileRoleClassifier';

test('classifyFileRole applies generated, test, config, docs, script, implementation, unknown priority', () => {
    assert.equal(classifyFileRole('src/app/main.py'), 'implementation');
    assert.equal(classifyFileRole('tests/test_main.py'), 'test');
    assert.equal(classifyFileRole('test_main.py'), 'test');
    assert.equal(classifyFileRole('main_test.py'), 'test');
    assert.equal(classifyFileRole('verify_e2e_system.py'), 'test');
    assert.equal(classifyFileRole('src/__tests__/app.test.ts'), 'test');
    assert.equal(classifyFileRole('src/app.spec.ts'), 'test');
    assert.equal(classifyFileRole('e2e/flow.test.ts'), 'test');
    assert.equal(classifyFileRole('package.json'), 'config');
    assert.equal(classifyFileRole('tsconfig.json'), 'config');
    assert.equal(classifyFileRole('pyproject.toml'), 'config');
    assert.equal(classifyFileRole('README.md'), 'docs');
    assert.equal(classifyFileRole('dist/bundle.min.js'), 'generated');
    assert.equal(classifyFileRole('node_modules/axios/index.js'), 'generated');
    assert.equal(classifyFileRole('package-lock.json'), 'generated');
    assert.equal(isTestFile('tests/test_main.py'), true);
    assert.equal(isTestFile('src/main.py'), false);
});

test('isImplementationFile only returns true for implementation role', () => {
    assert.equal(isImplementationFile('src/main.py'), true);
    assert.equal(isImplementationFile('tests/test_main.py'), false);
    assert.equal(isImplementationFile('package.json'), false);
    assert.equal(isImplementationFile('dist/bundle.min.js'), false);
});

test('classifyFileRole: a bare .env file is role "config", same as its .env.example/.env.sample siblings (regression -- previously fell through to "unknown" since path.posix.extname(".env") is "")', () => {
    assert.equal(classifyFileRole('.env'), 'config');
    assert.equal(classifyFileRole('config/.env'), 'config');
    assert.equal(classifyFileRole('.env.example'), 'config');
    assert.equal(classifyFileRole('.env.sample'), 'config');
});

test('classifyFileRole: every other dotted .env variant is also role "config", not just the two hardcoded example/sample names', () => {
    assert.equal(classifyFileRole('.env.local'), 'config');
    assert.equal(classifyFileRole('.env.production'), 'config');
    assert.equal(classifyFileRole('.env.development'), 'config');
});

test('classifyFileRole: does not accidentally widen matching to unrelated dotfiles or "environment"-named files', () => {
    assert.equal(classifyFileRole('.envrc'), 'unknown');
    assert.equal(classifyFileRole('environment.ts'), 'implementation');
    assert.equal(classifyFileRole('environment.txt'), 'docs');
});
