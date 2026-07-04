import { describe, test, expect } from '@jest/globals';
import { buildOrientationHtml, PanelDeps } from '../../ui/phase10Panels';

const PANEL_OPENING_COMMANDS = [
    'repoguide.indexHealth',
    'repoguide.memoryExplorerPanel',
    'repoguide.docreport',
    'repoguide.showDailyBrief',
    'repoguide.notesPanel',
    'repoguide.planTrackerPanel',
    'repoguide.openChat',
    'repoguide.investigationPanel',
    'repoguide.whatDoesThisFileAffect'
];

function makeDeps(): PanelDeps {
    return {
        context: {} as any,
        repoguideDir: '/nonexistent/.repoguide',
        workspaceRoot: '/nonexistent',
        investigationEngine: {} as any,
        planAnalyzer: {} as any,
        getIndexedFileCount: async () => 0
    };
}

describe('Orientation panel as the single entry-point dashboard', () => {
    test('surfaces a launcher to every real panel-opening capability, not just its own content', async () => {
        const html = await buildOrientationHtml(makeDeps());

        for (const command of PANEL_OPENING_COMMANDS) {
            expect(html).toContain(`runCommand('${command}')`);
        }
    });

    test('capabilities launcher is present even before the workspace has been indexed', async () => {
        // buildOrientationHtml's "not indexed yet" early-return path (repoguideDir
        // doesn't exist) must still include the launcher -- a first-time user with
        // no index yet is exactly who most needs to discover the other panels.
        const html = await buildOrientationHtml(makeDeps());
        expect(html).toContain('Run indexing first');
        expect(html).toContain('Capabilities');
        expect(html).toContain(`runCommand('repoguide.indexHealth')`);
    });
});
