import * as vscode from 'vscode';
import * as fs from 'fs';
import { IndexManager } from '../indexing/indexManager';
import { LanceStore } from '../store/lanceStore';
import { walkFiles } from '../indexing/fileWalker';
import { hashFileContent } from '../indexing/chunkHasher';
import {
    setFileHash, getFileHash, deleteFileHash,
    reconcileFileLists, fileNeedsReindex
} from './syncHelpers';
import { RepoGuideLogger } from '../logging/repoguideLogger';

// Re-export pure helpers so existing imports still work
export { reconcileFileLists, fileNeedsReindex, setFileHash, getFileHash, deleteFileHash, clearFileHashes } from './syncHelpers';

/**
 * Watches .git/HEAD and .git/index for changes that indicate branch switches,
 * merges, pulls, rebases, or staging changes. When detected, reconciles the
 * LanceDB index against the actual workspace files.
 *
 * Uses a 1000ms debounce because git operations write to HEAD and index
 * in rapid succession.
 */
export function registerGitWatcher(
    indexManager: IndexManager,
    store: LanceStore,
    workspaceRoot: string,
    logger: import('../context/repositoryContext').Logger
): vscode.Disposable {
    const headWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '.git/HEAD')
    );
    const indexWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '.git/index')
    );

    let timeout: NodeJS.Timeout | null = null;
    let isReconciling = false;
    const DEBOUNCE_MS = 1000;

    const handleChange = () => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(async () => {
            if (isReconciling) {
                return;
            }
            isReconciling = true;

            try {
                const storePaths = await store.getAllFilePaths();
                const workspacePaths = await walkFiles(workspaceRoot);

                const { toAdd, toCheck, toRemove } = reconcileFileLists(workspacePaths, storePaths);

                // Process deletions first (fast, no embedding needed)
                for (const p of toRemove) {
                    try {
                        await store.deleteChunksByFile(p);
                        deleteFileHash(p);
                    } catch (e) {
                        logger.error(`Git watcher: failed to delete chunks for ${p}: ${e}`);
                    }
                }

                // Process additions
                for (const p of toAdd) {
                    try {
                        await indexManager.incrementalUpdate(p);
                    } catch (e) {
                        logger.error(`Git watcher: failed to index new file ${p}: ${e}`);
                    }
                }

                // Check modifications using file-level hash comparison
                for (const p of toCheck) {
                    try {
                        const content = await fs.promises.readFile(p, 'utf-8');
                        const currentHash = hashFileContent(content);
                        const storedHash = getFileHash(p);

                        if (fileNeedsReindex(currentHash, storedHash)) {
                            await indexManager.incrementalUpdate(p);
                        }
                    } catch (e) {
                        logger.error(`Git watcher: failed to check file ${p}: ${e}`);
                    }
                }
            } catch (e) {
                logger.error(`Git watcher reconciliation failed: ${e}`);
            } finally {
                isReconciling = false;
            }
        }, DEBOUNCE_MS);
    };

    headWatcher.onDidChange(handleChange);
    headWatcher.onDidCreate(handleChange);
    indexWatcher.onDidChange(handleChange);
    indexWatcher.onDidCreate(handleChange);

    return {
        dispose: () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            headWatcher.dispose();
            indexWatcher.dispose();
        }
    };
}
