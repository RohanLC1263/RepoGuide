import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface ArtifactSnapshotMetadata {
    schemaVersion: '1.0';
    snapshotId: string;
    repoName: string;
    repoPath: string;
    gitCommit: string | null;
    repoguideVersion: string;
    createdAt: string;
    sourceUnderstandingDir: string;
}

export interface ArtifactSnapshotResult {
    snapshotId: string;
    snapshotDir: string;
    metadataPath: string;
    metadata: ArtifactSnapshotMetadata;
}

export function createArtifactSnapshot(repoPath: string, label?: string): ArtifactSnapshotResult {
    const workspaceRoot = path.resolve(repoPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const understandingDir = path.join(repoguideDir, 'understanding');
    if (!fs.existsSync(understandingDir)) {
        throw new Error(`Understanding directory does not exist: ${understandingDir}`);
    }

    const createdAt = new Date().toISOString();
    const repoName = path.basename(workspaceRoot);
    const gitCommit = readGitCommit(workspaceRoot);
    const repoguideVersion = readRepoGuideVersion();
    const suffix = label ? sanitize(label) : 'snapshot';
    const hashPart = gitCommit ? gitCommit.slice(0, 12) : 'nogit';
    const snapshotId = `${createdAt.replace(/[:.]/g, '-')}_${sanitize(repoName)}_${hashPart}_${suffix}`;
    const snapshotDir = path.join(repoguideDir, 'snapshots', snapshotId);
    const snapshotUnderstandingDir = path.join(snapshotDir, 'understanding');

    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.cpSync(understandingDir, snapshotUnderstandingDir, { recursive: true });

    const metadata: ArtifactSnapshotMetadata = {
        schemaVersion: '1.0',
        snapshotId,
        repoName,
        repoPath: workspaceRoot,
        gitCommit,
        repoguideVersion,
        createdAt,
        sourceUnderstandingDir: understandingDir
    };
    const metadataPath = path.join(snapshotDir, 'metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    return { snapshotId, snapshotDir, metadataPath, metadata };
}

export function restoreArtifactSnapshot(repoPath: string, snapshotPathOrId: string): ArtifactSnapshotResult {
    const workspaceRoot = path.resolve(repoPath);
    const repoguideDir = path.join(workspaceRoot, '.repoguide');
    const snapshotDir = resolveSnapshotDir(repoguideDir, snapshotPathOrId);
    const snapshotUnderstandingDir = path.join(snapshotDir, 'understanding');
    const metadataPath = path.join(snapshotDir, 'metadata.json');

    if (!fs.existsSync(snapshotUnderstandingDir)) {
        throw new Error(`Snapshot understanding directory does not exist: ${snapshotUnderstandingDir}`);
    }

    const understandingDir = path.join(repoguideDir, 'understanding');
    fs.rmSync(understandingDir, { recursive: true, force: true });
    fs.mkdirSync(repoguideDir, { recursive: true });
    fs.cpSync(snapshotUnderstandingDir, understandingDir, { recursive: true });

    const metadata = fs.existsSync(metadataPath)
        ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ArtifactSnapshotMetadata
        : fallbackMetadata(workspaceRoot, snapshotDir);

    return {
        snapshotId: metadata.snapshotId,
        snapshotDir,
        metadataPath,
        metadata
    };
}

export function listArtifactSnapshots(repoPath: string): ArtifactSnapshotResult[] {
    const workspaceRoot = path.resolve(repoPath);
    const snapshotsDir = path.join(workspaceRoot, '.repoguide', 'snapshots');
    if (!fs.existsSync(snapshotsDir)) {
        return [];
    }

    return fs.readdirSync(snapshotsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(snapshotsDir, entry.name))
        .filter(snapshotDir => fs.existsSync(path.join(snapshotDir, 'understanding')))
        .map(snapshotDir => {
            const metadataPath = path.join(snapshotDir, 'metadata.json');
            const metadata = fs.existsSync(metadataPath)
                ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as ArtifactSnapshotMetadata
                : fallbackMetadata(workspaceRoot, snapshotDir);
            return {
                snapshotId: metadata.snapshotId,
                snapshotDir,
                metadataPath,
                metadata
            };
        })
        .sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
}

function resolveSnapshotDir(repoguideDir: string, snapshotPathOrId: string): string {
    const direct = path.resolve(snapshotPathOrId);
    if (fs.existsSync(direct)) {
        return direct;
    }
    return path.join(repoguideDir, 'snapshots', snapshotPathOrId);
}

function fallbackMetadata(repoPath: string, snapshotDir: string): ArtifactSnapshotMetadata {
    return {
        schemaVersion: '1.0',
        snapshotId: path.basename(snapshotDir),
        repoName: path.basename(repoPath),
        repoPath,
        gitCommit: null,
        repoguideVersion: readRepoGuideVersion(),
        createdAt: new Date(0).toISOString(),
        sourceUnderstandingDir: path.join(repoPath, '.repoguide', 'understanding')
    };
}

function readGitCommit(repoPath: string): string | null {
    try {
        return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

function readRepoGuideVersion(): string {
    try {
        const packageJsonPath = path.resolve(__dirname, '../../package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
        return packageJson.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function sanitize(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'snapshot';
}
