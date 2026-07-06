import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test, expect, afterEach } from '@jest/globals';
import { resolveWorkspaceFilePath, findCaseInsensitiveMatch } from '../../ui/workspacePathResolver';

describe('resolveWorkspaceFilePath', () => {
    const workspaceRoot = path.join('C:', 'workspace', 'project');

    test('resolves a relative path inside the workspace', () => {
        const result = resolveWorkspaceFilePath('src/index.ts', workspaceRoot);
        expect(result).toBe(path.join(workspaceRoot, 'src', 'index.ts'));
    });

    test('accepts an absolute path that is genuinely inside the workspace', () => {
        const inside = path.join(workspaceRoot, 'src', 'index.ts');
        const result = resolveWorkspaceFilePath(inside, workspaceRoot);
        expect(result).toBe(path.resolve(inside));
    });

    test('refuses a relative path that escapes the workspace via ../', () => {
        const result = resolveWorkspaceFilePath('../../../etc/passwd', workspaceRoot);
        expect(result).toBeNull();
    });

    test('refuses an absolute path outside the workspace entirely', () => {
        const outside = path.join('C:', 'Users', 'victim', '.ssh', 'id_rsa');
        const result = resolveWorkspaceFilePath(outside, workspaceRoot);
        expect(result).toBeNull();
    });

    test('refuses a sibling directory that merely shares a name prefix with the workspace', () => {
        // "C:/workspace/project-evil" is NOT inside "C:/workspace/project" --
        // a naive startsWith() string check would incorrectly accept this.
        const sibling = path.join('C:', 'workspace', 'project-evil', 'secret.ts');
        const result = resolveWorkspaceFilePath(sibling, workspaceRoot);
        expect(result).toBeNull();
    });

    test('accepts the workspace root itself', () => {
        const result = resolveWorkspaceFilePath('.', workspaceRoot);
        expect(result).toBe(path.resolve(workspaceRoot));
    });
});

describe('findCaseInsensitiveMatch', () => {
    let tempRoot: string;

    afterEach(() => {
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('finds a real file when the requested path has the wrong case', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-case-test-'));
        const realDir = path.join(tempRoot, 'app-header-component for CraftConnect', 'app');
        fs.mkdirSync(realDir, { recursive: true });
        const realFile = path.join(realDir, 'layout.tsx');
        fs.writeFileSync(realFile, 'export default function Layout() {}');

        const wrongCaseRelative = path.join('app-header-component for craftconnect', 'app', 'layout.tsx');
        const result = findCaseInsensitiveMatch(tempRoot, wrongCaseRelative);
        expect(result).toBe(realFile);
    });

    test('returns null when no case-insensitive match exists anywhere along the path', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-case-test-'));
        fs.mkdirSync(path.join(tempRoot, 'real-dir'), { recursive: true });

        const result = findCaseInsensitiveMatch(tempRoot, path.join('nonexistent-dir', 'file.ts'));
        expect(result).toBeNull();
    });

    // Note: a combined end-to-end test (mocking process.platform to non-win32 AND
    // forcing fs.existsSync to report the wrong-case path as missing) was attempted
    // but dropped -- fs.existsSync is a non-configurable getter on this module's
    // export object in this Node version, so neither jest.spyOn nor a direct
    // property assignment can override it. The wiring this would have verified
    // (resolveWorkspaceFilePath calls findCaseInsensitiveMatch when the direct path
    // is missing, on non-Windows) is a straightforward two-line call in the source;
    // the matching logic itself is fully covered by the two tests above, and the
    // platform gate is covered by the test below.

    test('resolveWorkspaceFilePath does not attempt the case-insensitive fallback on Windows', () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguide-case-test-'));
        const realDir = path.join(tempRoot, 'app-header-component for CraftConnect', 'app');
        fs.mkdirSync(realDir, { recursive: true });
        fs.writeFileSync(path.join(realDir, 'layout.tsx'), 'export default function Layout() {}');

        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            const wrongCaseRelative = path.join('app-header-component for craftconnect', 'app', 'layout.tsx');
            const result = resolveWorkspaceFilePath(wrongCaseRelative, tempRoot);
            // On win32 the fallback is skipped entirely -- returns the naive (wrong-case) join, unchanged.
            expect(result).toBe(path.resolve(tempRoot, wrongCaseRelative));
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
        }
    });
});
