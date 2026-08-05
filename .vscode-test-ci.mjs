import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The Extension Development Host lane for CI. Everything here needs a REAL VS Code
// instance -- these tests import `vscode` and cannot run headless under node:test or
// plain mocha, so without this lane they are simply never executed anywhere.
//
// What runs here and why:
//   phase0Panels           -- activates the extension and asserts its contributed
//                             commands are registered. This is the lane's whole point:
//                             a partial activation (commands missing) is invisible to
//                             every headless test, and was observed happening during the
//                             P0-2 work.
//   ollamaUrlWorkspaceScope -- proves VS Code honours `"scope": "machine"` on
//                             repoguide.ollamaUrl, i.e. that a workspace cannot redirect
//                             inference to an attacker-chosen host. That is VS Code
//                             settings-resolver behaviour; no unit test can establish it.
//                             It self-skips unless PROBE_WS is the fixture below, so the
//                             fixture is built here rather than left to the caller.
//
// NOT here: investigationUI.test.js. It requires a local CraftConnect checkout
// (CRAFTCONNECT_PATH, see .vscode-test.mjs) that does not exist on a CI runner. Deferred
// deliberately -- see ROADMAP.md, "CI runs the real suite (P0-4)".

const workspaceFolder = process.env.PROBE_WS
    || fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-ci-ws-'));

// ollamaUrlWorkspaceScope asserts that this workspace-level setting is IGNORED. Writing
// it here means the assertion is meaningful: the hostile value really is present.
const dotVscode = path.join(workspaceFolder, '.vscode');
fs.mkdirSync(dotVscode, { recursive: true });
fs.writeFileSync(
    path.join(dotVscode, 'settings.json'),
    JSON.stringify({ 'repoguide.ollamaUrl': 'http://127.0.0.1:47913' }, null, 2)
);

export default defineConfig({
    files: [
        'out/test/phase0Panels.test.js',
        'out/test/health/ollamaUrlWorkspaceScope.test.js'
    ],
    workspaceFolder,
    mocha: { ui: 'tdd', timeout: 120000 }
});
