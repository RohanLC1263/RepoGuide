import { defineConfig } from '@vscode/test-cli';

// This vscode-test run opens a real workspace (a local CraftConnect checkout)
// to exercise out/test/investigationUI.test.js against it. There is no
// hardcoded fallback path: if CRAFTCONNECT_PATH is unset, fail loudly with
// instructions instead of pointing at a directory that only existed on the
// original author's machine. Note: CI does not run this (`npm run test`); it
// runs `npm run test:unit`, so this requirement does not affect CI.
const workspaceFolder = process.env.CRAFTCONNECT_PATH;
if (!workspaceFolder) {
	throw new Error(
		'CRAFTCONNECT_PATH is not set. `npm run test` (vscode-test) opens a local ' +
		'CraftConnect workspace for out/test/investigationUI.test.js. Set it first, e.g. ' +
		'PowerShell: $env:CRAFTCONNECT_PATH = "C:\\path\\to\\CraftConnect"  |  ' +
		'macOS/Linux: export CRAFTCONNECT_PATH=/path/to/CraftConnect'
	);
}

export default defineConfig({
	files: 'out/test/investigationUI.test.js',
	workspaceFolder,
});
