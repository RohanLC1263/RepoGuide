import * as fs from 'fs';
import * as path from 'path';

type OutputLogger = {
    appendLine(message: string): void;
};

type WarningSink = (message: string) => void;

interface RootCandidate {
    root: string;
    marker: string;
    priority: number;
    distanceFromWorkspace: number;
}

const MAX_UPWARD_DEPTH = 3;
const MAX_DESCENDANT_DEPTH = 2;

const STRONG_FILE_MARKERS = ['pyproject.toml', 'package.json', 'Cargo.toml'];
const SECONDARY_FILE_MARKERS = ['requirements.txt', 'setup.py', 'go.mod'];
const DIRECTORY_MARKERS = ['src', 'app'];
const SKIPPED_DESCENDANT_DIRS = new Set([
    '.git',
    '.repoguide',
    'node_modules',
    'dist',
    'out',
    'build',
    'coverage',
    '.venv',
    'venv',
    '__pycache__'
]);

export class WorkspaceRootDetector {
    private readonly root: string;
    private readonly repoguideDir: string;

    constructor(
        workspaceFolder: string,
        private readonly outputChannel?: OutputLogger,
        private readonly warningSink?: WarningSink
    ) {
        const resolvedWorkspaceFolder = path.resolve(workspaceFolder);
        const result = detectWorkspaceRootWithReason(resolvedWorkspaceFolder);
        this.root = result.root;
        this.repoguideDir = path.join(this.root, '.repoguide');

        if (result.fellBack) {
            this.warningSink?.(
                `RepoGuide: No project markers found under ${resolvedWorkspaceFolder}. ` +
                'Using workspace folder for indexing.'
            );
        } else if (path.normalize(this.root) !== path.normalize(resolvedWorkspaceFolder)) {
            this.warningSink?.(
                `RepoGuide: Project root detected at ${this.root}, not ${resolvedWorkspaceFolder}. ` +
                'Using detected root for indexing.'
            );
        }

        this.outputChannel?.appendLine(`[Info] Workspace root: ${this.root}`);
    }

    getRoot(): string {
        return this.root;
    }

    getRepoguideDir(): string {
        return this.repoguideDir;
    }
}

export function detectWorkspaceRoot(workspaceFolder: string): string {
    return detectWorkspaceRootWithReason(workspaceFolder).root;
}

function detectWorkspaceRootWithReason(workspaceFolder: string): { root: string; fellBack: boolean } {
    const candidates: RootCandidate[] = [
        ...findMarkerCandidatesAtOrBelow(workspaceFolder),
        ...findGitCandidatesWalkingUp(workspaceFolder)
    ];

    if (candidates.length === 0) {
        return { root: path.resolve(workspaceFolder), fellBack: true };
    }

    candidates.sort(compareCandidates);
    return { root: candidates[0].root, fellBack: false };
}

function findMarkerCandidatesAtOrBelow(workspaceFolder: string): RootCandidate[] {
    const candidates: RootCandidate[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: workspaceFolder, depth: 0 }];

    while (queue.length > 0) {
        const current = queue.shift()!;
        candidates.push(...getNonGitCandidates(current.dir, current.depth));

        if (current.depth >= MAX_DESCENDANT_DEPTH) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || SKIPPED_DESCENDANT_DIRS.has(entry.name)) {
                continue;
            }
            queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
    }

    return candidates;
}

function getNonGitCandidates(dir: string, depth: number): RootCandidate[] {
    const candidates: RootCandidate[] = [];

    for (const marker of STRONG_FILE_MARKERS) {
        if (existsFile(path.join(dir, marker))) {
            candidates.push(candidate(dir, marker, 100, depth));
        }
    }

    for (const marker of SECONDARY_FILE_MARKERS) {
        if (existsFile(path.join(dir, marker))) {
            candidates.push(candidate(dir, marker, 90, depth));
        }
    }

    if (depth <= 1) {
        for (const marker of DIRECTORY_MARKERS) {
            if (existsDirectory(path.join(dir, marker))) {
                candidates.push(candidate(dir, `${marker}/`, 80, depth));
            }
        }
    }

    return candidates;
}

function findGitCandidatesWalkingUp(workspaceFolder: string): RootCandidate[] {
    const candidates: RootCandidate[] = [];
    let current = workspaceFolder;

    for (let depth = 0; depth <= MAX_UPWARD_DEPTH; depth++) {
        if (existsDirectory(path.join(current, '.git'))) {
            candidates.push(candidate(current, '.git/', 110, -depth));
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return candidates;
}

function candidate(
    root: string,
    marker: string,
    priority: number,
    distanceFromWorkspace: number
): RootCandidate {
    return {
        root: path.resolve(root),
        marker,
        priority,
        distanceFromWorkspace
    };
}

function compareCandidates(left: RootCandidate, right: RootCandidate): number {
    const leftSpecificity = specificity(left);
    const rightSpecificity = specificity(right);
    if (leftSpecificity !== rightSpecificity) {
        return rightSpecificity - leftSpecificity;
    }
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }
    return left.root.localeCompare(right.root);
}

function specificity(candidate: RootCandidate): number {
    return 1000 - Math.abs(candidate.distanceFromWorkspace);
}

function existsFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function existsDirectory(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}
