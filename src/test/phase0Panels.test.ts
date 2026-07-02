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
            'repoguide.orientationPanel',
            'repoguide.investigationPanel',
            'repoguide.planTrackerPanel'
        ];

        for (const command of expectedCommands) {
            assert.ok(commandIds.includes(command), `${command} should be registered`);
        }

        await vscode.commands.executeCommand('repoguide.openChat');
        await vscode.commands.executeCommand('repoguide.orientationPanel');
        await vscode.commands.executeCommand('repoguide.investigationPanel');
        await vscode.commands.executeCommand('repoguide.planTrackerPanel');
        await vscode.commands.executeCommand('repoguide.indexHealth');
    });
});
