import { describe, test, expect, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerPhase10Panels } from '../../ui/phase10Panels';

/**
 * The Orientation panel (repoguide.orientationPanel, showOrientationPanel,
 * buildOrientationHtml, maybeShowOrientationOnOpen) was removed 2026-07-10 --
 * after Key Modules and the never-implemented project synthesis were
 * stripped out earlier that week, it was down to a duplicate of Entry
 * Points. Investigation confirmed the annotation pipeline itself is
 * untouched: evidence-packet enrichment, retrieval seeding, the
 * Investigation engine, Plan Tracker, and community summaries all consume
 * FileAnnotationEngine directly, none of them through Orientation.
 *
 * This file has two jobs:
 *  1. Regression-check that Investigation and Plan Tracker -- which shared
 *     phase10Panels.ts with Orientation -- still register and open
 *     correctly, not just "Orientation is gone."
 *  2. Removal-guard: grep the actual shipped source for dangling references
 *     to the removed functions/command, the same pattern used for the
 *     chat-panel readiness-pill removal.
 */

function fakeWebviewPanel() {
    const disposeCallbacks: Array<() => void> = [];
    const messageCallbacks: Array<(msg: unknown) => void> = [];
    return {
        viewType: '',
        title: '',
        webview: {
            html: '',
            onDidReceiveMessage: (cb: (msg: unknown) => void) => {
                messageCallbacks.push(cb);
                return { dispose: () => undefined };
            }
        },
        onDidDispose: (cb: () => void) => {
            disposeCallbacks.push(cb);
            return { dispose: () => undefined };
        },
        reveal: () => undefined,
        _fireDispose: () => disposeCallbacks.forEach(cb => cb())
    };
}

describe('Investigation and Plan Tracker panels: regression check after Orientation removal', () => {
    let registered: Map<string, (...args: unknown[]) => unknown>;
    let createdPanels: ReturnType<typeof fakeWebviewPanel>[];

    beforeEach(() => {
        registered = new Map();
        createdPanels = [];
        (vscode.commands as any).registerCommand = (id: string, handler: (...args: unknown[]) => unknown) => {
            registered.set(id, handler);
            return { dispose: () => undefined };
        };
        (vscode.window as any).createWebviewPanel = () => {
            const panel = fakeWebviewPanel();
            createdPanels.push(panel);
            return panel;
        };
    });

    function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
        return {
            context: { subscriptions: [] } as any,
            repoguideDir: '/nonexistent/.repoguide',
            workspaceRoot: '/nonexistent',
            investigationEngine: {} as any,
            planAnalyzer: {} as any,
            ...overrides
        };
    }

    test('registerPhase10Panels registers exactly investigationPanel and planTrackerPanel -- never orientationPanel', async () => {
        registerPhase10Panels(makeDeps());

        expect(registered.has('repoguide.investigationPanel')).toBe(true);
        expect(registered.has('repoguide.planTrackerPanel')).toBe(true);
        expect(registered.has('repoguide.orientationPanel')).toBe(false);
        expect(registered.size).toBe(2);
    });

    // investigationPanel/planTrackerPanel are module-level singletons in
    // phase10Panels.ts (the same design as the removed orientationPanel var),
    // and jest caches that module across tests within this file -- so their
    // full open/reveal lifecycle is exercised as one sequenced test instead
    // of assuming fresh module state per test, matching how a real extension
    // host actually uses them (register once, open/reveal repeatedly).
    test('investigationPanel and planTrackerPanel open real webview panels with correct content, and reveal (not duplicate) on repeat invocation', async () => {
        registerPhase10Panels(makeDeps());

        await registered.get('repoguide.investigationPanel')!();
        expect(createdPanels.length).toBe(1);
        expect(createdPanels[0].webview.html).toContain('<title>Investigation</title>');
        expect(createdPanels[0].webview.html).toContain('Run indexing first');

        await registered.get('repoguide.investigationPanel')!();
        expect(createdPanels.length).toBe(1);

        await registered.get('repoguide.planTrackerPanel')!();
        expect(createdPanels.length).toBe(2);
        expect(createdPanels[1].webview.html).toContain('<title>Plan Tracker</title>');
        expect(createdPanels[1].webview.html).toContain('Run indexing first');

        await registered.get('repoguide.planTrackerPanel')!();
        expect(createdPanels.length).toBe(2);
    });
});

describe('REMOVAL GUARD: no dangling references to the removed Orientation panel', () => {
    const PHASE10_SOURCE = fs.readFileSync(path.join(__dirname, '../../ui/phase10Panels.ts'), 'utf8');
    const EXTENSION_SOURCE = fs.readFileSync(path.join(__dirname, '../../extension.ts'), 'utf8');
    const PACKAGE_JSON_SOURCE = fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8');
    const SIDEBAR_JS_SOURCE = fs.readFileSync(path.join(__dirname, '../../../webviews/sidebar/sidebar.js'), 'utf8');
    const PHASE0_SMOKE_SOURCE = fs.readFileSync(path.join(__dirname, '../phase0Panels.test.ts'), 'utf8');

    test('phase10Panels.ts no longer defines the removed functions/state', () => {
        for (const name of [
            'showOrientationPanel',
            'buildOrientationHtml',
            'maybeShowOrientationOnOpen',
            'hasValidAnnotations',
            'buildCapabilitiesSection',
            'readProjectSummary',
            'readEntryPoints',
            'fileExistsInWorkspace',
            'entryPointDisplayPath',
            'orientationPanel'
        ]) {
            expect(PHASE10_SOURCE).not.toContain(name);
        }
    });

    test('phase10Panels.ts no longer registers the repoguide.orientationPanel command', () => {
        expect(PHASE10_SOURCE).not.toContain('repoguide.orientationPanel');
    });

    test('phase10Panels.ts still registers investigationPanel and planTrackerPanel commands (source-level)', () => {
        expect(PHASE10_SOURCE).toContain("'repoguide.investigationPanel'");
        expect(PHASE10_SOURCE).toContain("'repoguide.planTrackerPanel'");
    });

    test('extension.ts no longer references the removed getIndexedFileCount/outputChannel plumbing for phase10Panels', () => {
        const registerCall = EXTENSION_SOURCE.slice(EXTENSION_SOURCE.indexOf('registerPhase10Panels({'));
        const callBody = registerCall.slice(0, registerCall.indexOf('});') + 3);
        expect(callBody).not.toContain('getIndexedFileCount');
        expect(callBody).not.toContain('outputChannel');
    });

    test('package.json no longer contributes the repoguide.orientationPanel command', () => {
        expect(PACKAGE_JSON_SOURCE).not.toContain('repoguide.orientationPanel');
        const contributed = JSON.parse(PACKAGE_JSON_SOURCE);
        const commandIds = (contributed.contributes?.commands ?? []).map((c: { command: string }) => c.command);
        expect(commandIds).not.toContain('repoguide.orientationPanel');
        expect(commandIds).toContain('repoguide.investigationPanel');
        expect(commandIds).toContain('repoguide.planTrackerPanel');
    });

    test('sidebar.js no longer tells the user to click the (now-removed) Orientation panel', () => {
        expect(SIDEBAR_JS_SOURCE).not.toContain('Click the Orientation panel');
    });

    test('the Extension Host smoke test no longer executes repoguide.orientationPanel as a command (it may still name it in a negative assertion proving it is gone)', () => {
        expect(PHASE0_SMOKE_SOURCE).not.toContain("executeCommand('repoguide.orientationPanel')");
        expect(PHASE0_SMOKE_SOURCE).toContain('!commandIds.includes(\'repoguide.orientationPanel\')');
    });
});
