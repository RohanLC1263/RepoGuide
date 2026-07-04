import * as path from 'path';
import { describe, test, expect } from '@jest/globals';
import { resolveWorkspaceFilePath } from '../../ui/workspacePathResolver';

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
