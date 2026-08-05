import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { resolveOllamaUrl, resolveOllamaUrlDetailed } from '../../health/ollamaUrlSafety';

/**
 * Runs INSIDE a real VS Code Extension Development Host, against a workspace whose
 * `.vscode/settings.json` sets `repoguide.ollamaUrl` to an attacker-controlled endpoint.
 *
 * WHY THIS EXISTS AS AN EDH TEST AND NOT A UNIT TEST. The whole privacy fix rests on VS
 * Code honouring `"scope": "machine"` by refusing workspace/folder overrides. That is
 * behaviour of VS Code's settings resolver, not of RepoGuide's code -- no amount of green
 * unit tests proves it. Only asking a real VS Code instance, with a real malicious
 * workspace open, proves it.
 *
 * Companion evidence: an HTTP listener on ATTACKER_PORT records whether traffic actually
 * arrives. `scripts/` is not involved; see the engineering log entry for the run commands.
 *
 * Skips (rather than fails) when the fixture workspace is not the one open, so it cannot
 * break the ordinary `npm test` run against a different workspaceFolder.
 */

const ATTACKER_URL = 'http://127.0.0.1:47913';
const LOOPBACK_DEFAULT = 'http://localhost:11434';

function fixtureWorkspaceIsOpen(): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.some(f => fs.existsSync(f.uri.fsPath + '/.vscode/settings.json')
        && fs.readFileSync(f.uri.fsPath + '/.vscode/settings.json', 'utf8').includes('47913'));
}

suite('ollamaUrl workspace-scope containment (real Extension Development Host)', () => {

    test('the fixture workspace really does declare the attacker endpoint', function () {
        if (!fixtureWorkspaceIsOpen()) { this.skip(); return; }
        const folder = (vscode.workspace.workspaceFolders ?? [])[0];
        const raw = fs.readFileSync(folder.uri.fsPath + '/.vscode/settings.json', 'utf8');
        assert.ok(raw.includes('47913'), 'fixture must contain the attacker port, or the test proves nothing');
    });

    test('VS Code does NOT let the workspace override a machine-scoped ollamaUrl', function () {
        if (!fixtureWorkspaceIsOpen()) { this.skip(); return; }
        const effective = vscode.workspace.getConfiguration('repoguide').get<string>('ollamaUrl');
        console.log(`[probe] effective repoguide.ollamaUrl = ${effective}`);
        assert.notStrictEqual(
            effective,
            ATTACKER_URL,
            'workspace .vscode/settings.json overrode ollamaUrl -- machine scope is NOT in effect'
        );
    });

    test('the resolver returns a loopback endpoint for this workspace', function () {
        if (!fixtureWorkspaceIsOpen()) { this.skip(); return; }
        const resolved = resolveOllamaUrl({
            getConfig: <T>(key: string, fallback?: T) =>
                vscode.workspace.getConfiguration('repoguide').get(key, fallback as T)
        });
        console.log(`[probe] resolveOllamaUrl() = ${resolved}`);
        assert.notStrictEqual(resolved, ATTACKER_URL, 'resolver handed back the attacker endpoint');
        assert.ok(
            resolved === LOOPBACK_DEFAULT || resolved.includes('127.0.0.1:11434') || resolved.includes('localhost'),
            `expected a loopback endpoint, got ${resolved}`
        );
    });

    test('a real request through the resolved endpoint does not reach the attacker port', async function () {
        if (!fixtureWorkspaceIsOpen()) { this.skip(); return; }
        this.timeout(20000);
        const resolved = resolveOllamaUrl({
            getConfig: <T>(key: string, fallback?: T) =>
                vscode.workspace.getConfiguration('repoguide').get(key, fallback as T)
        });
        // Mirrors embedder.ts's call shape. Failure to connect is fine and expected when
        // no local Ollama is up -- what matters is WHERE it was addressed.
        try {
            await fetch(`${resolved}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'probe' })
            });
        } catch { /* connection outcome is irrelevant; the destination is the evidence */ }
        assert.ok(!resolved.includes('47913'), 'request was addressed to the attacker port');
    });

    test('a legitimate remote Ollama set in USER (machine) settings still works when opted in', async function () {
        if (!fixtureWorkspaceIsOpen()) { this.skip(); return; }
        this.timeout(20000);
        const cfg = vscode.workspace.getConfiguration('repoguide');
        const LAN = 'http://192.168.1.50:11434';
        try {
            // ConfigurationTarget.Global is the only target a machine-scoped setting accepts.
            // If machine scope somehow broke this path, the LAN case would silently stop
            // working -- which is the regression this test exists to catch.
            await cfg.update('ollamaUrl', LAN, vscode.ConfigurationTarget.Global);
            await cfg.update('allowRemoteOllama', true, vscode.ConfigurationTarget.Global);

            const fresh = vscode.workspace.getConfiguration('repoguide');
            const detailed = resolveOllamaUrlDetailed({
                getConfig: <T>(key: string, fallback?: T) => fresh.get(key, fallback as T)
            });
            console.log(`[probe] opted-in resolution = ${JSON.stringify(detailed)}`);
            assert.strictEqual(detailed.url, LAN, 'an explicitly opted-in remote must still be usable');
            assert.strictEqual(detailed.outcome, 'remote-allowed', 'this is the case that SHOULD warn');
        } finally {
            await cfg.update('ollamaUrl', undefined, vscode.ConfigurationTarget.Global);
            await cfg.update('allowRemoteOllama', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('the same remote WITHOUT the opt-in is blocked, and reports it rather than failing silently', async function () {
        if (!fixtureWorkspaceIsOpen()) { this.skip(); return; }
        this.timeout(20000);
        const cfg = vscode.workspace.getConfiguration('repoguide');
        const LAN = 'http://192.168.1.50:11434';
        try {
            await cfg.update('ollamaUrl', LAN, vscode.ConfigurationTarget.Global);
            const fresh = vscode.workspace.getConfiguration('repoguide');
            const detailed = resolveOllamaUrlDetailed({
                getConfig: <T>(key: string, fallback?: T) => fresh.get(key, fallback as T)
            });
            console.log(`[probe] not-opted-in resolution = ${JSON.stringify(detailed)}`);
            assert.notStrictEqual(detailed.url, LAN, 'must not send off-machine without opt-in');
            assert.strictEqual(detailed.outcome, 'remote-blocked');
            assert.strictEqual(detailed.requested, LAN, 'the ignored request is retained so the user can be told');
        } finally {
            await cfg.update('ollamaUrl', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('the default local case is classified local, so no warning fires', function () {
        if (!fixtureWorkspaceIsOpen()) { this.skip(); return; }
        const detailed = resolveOllamaUrlDetailed({
            getConfig: <T>(key: string, fallback?: T) =>
                vscode.workspace.getConfiguration('repoguide').get(key, fallback as T)
        });
        assert.strictEqual(detailed.outcome, 'local', 'the ordinary local setup must not warn');
    });
});
