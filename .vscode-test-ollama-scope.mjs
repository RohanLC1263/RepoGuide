// Runs src/test/health/ollamaUrlWorkspaceScope.test.ts in a REAL Extension Development
// Host. That test proves VS Code honours `"scope": "machine"` on repoguide.ollamaUrl,
// which is behaviour of VS Code's settings resolver rather than of RepoGuide -- no unit
// test can establish it.
//
// Reproduce the fixture workspace it expects:
//   mkdir -p /tmp/ollama_probe_ws/.vscode
//   echo '{ "repoguide.ollamaUrl": "http://127.0.0.1:47913" }' > /tmp/ollama_probe_ws/.vscode/settings.json
// Optionally stand a listener on 47913 to observe that nothing arrives, then:
//   PROBE_WS=/tmp/ollama_probe_ws npx vscode-test --config .vscode-test-ollama-scope.mjs
//
// The test skips itself when PROBE_WS is not that fixture, so it cannot fail a normal run.
import { defineConfig } from '@vscode/test-cli';
export default defineConfig({
    files: 'out/test/health/ollamaUrlWorkspaceScope.test.js',
    workspaceFolder: process.env.PROBE_WS,
    mocha: { ui: 'tdd', timeout: 30000 }
});
