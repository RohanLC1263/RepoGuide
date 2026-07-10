import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Phase 0 panel command smoke', function () {
    this.timeout(60_000);

    test('contributed RepoGuide commands activate and execute', async () => {
        const extension = vscode.extensions.all.find(ext => ext.packageJSON?.name === 'repoguide');
        assert.ok(extension, 'RepoGuide extension should be installed in the Extension Host');
        await extension.activate();

        const commandIds = await vscode.commands.getCommands(true);
        const expectedCommands = [
            'repoguide.openChat',
            'repoguide.explain',
            'repoguide.indexHealth',
            'repoguide.investigationPanel',
            'repoguide.planTrackerPanel'
        ];

        for (const command of expectedCommands) {
            assert.ok(commandIds.includes(command), `${command} should be registered`);
        }

        // Orientation panel removed 2026-07-10 (low-value once Key Modules and
        // the never-implemented project synthesis were stripped out, leaving
        // only a duplicate of Entry Points) -- guard against it silently coming
        // back registered via a stale command contribution or call site.
        assert.ok(!commandIds.includes('repoguide.orientationPanel'), 'repoguide.orientationPanel should no longer be registered');

        await vscode.commands.executeCommand('repoguide.openChat');
        await vscode.commands.executeCommand('repoguide.investigationPanel');
        await vscode.commands.executeCommand('repoguide.planTrackerPanel');
        await vscode.commands.executeCommand('repoguide.indexHealth');
    });
});
