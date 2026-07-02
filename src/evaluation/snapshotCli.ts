import * as fs from 'fs';
import * as path from 'path';
import { createArtifactSnapshot, listArtifactSnapshots, restoreArtifactSnapshot } from './artifactSnapshots';

interface Args {
    command: 'create' | 'restore' | 'list' | 'help';
    repo: string;
    snapshot?: string;
    label?: string;
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === 'help') {
        printHelp();
        return;
    }

    if (args.command === 'create') {
        const snapshot = createArtifactSnapshot(args.repo, args.label);
        console.log(`Created artifact snapshot: ${snapshot.snapshotId}`);
        console.log(`Snapshot dir: ${snapshot.snapshotDir}`);
        console.log(`Metadata: ${snapshot.metadataPath}`);
        return;
    }

    if (args.command === 'restore') {
        if (!args.snapshot) {
            throw new Error('restore requires --snapshot <id-or-path>');
        }
        const snapshot = restoreArtifactSnapshot(args.repo, args.snapshot);
        console.log(`Restored artifact snapshot: ${snapshot.snapshotId}`);
        console.log(`Snapshot dir: ${snapshot.snapshotDir}`);
        return;
    }

    const snapshots = listArtifactSnapshots(args.repo);
    if (snapshots.length === 0) {
        console.log('No artifact snapshots found.');
        return;
    }
    for (const snapshot of snapshots) {
        console.log(`${snapshot.snapshotId}\t${snapshot.metadata.createdAt}\t${snapshot.metadata.gitCommit ?? 'nogit'}`);
    }
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        command: 'help',
        repo: process.cwd()
    };

    const first = argv[0];
    if (first === 'create' || first === 'restore' || first === 'list') {
        args.command = first;
        argv = argv.slice(1);
    }

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--repo':
                args.repo = requireValue(arg, next);
                i += 1;
                break;
            case '--snapshot':
                args.snapshot = requireValue(arg, next);
                i += 1;
                break;
            case '--label':
                args.label = requireValue(arg, next);
                i += 1;
                break;
            case '--help':
            case '-h':
                args.command = 'help';
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (args.command !== 'help' && !fs.existsSync(args.repo)) {
        throw new Error(`Repo path does not exist: ${args.repo}`);
    }

    return args;
}

function requireValue(flag: string, value: string | undefined): string {
    if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function printHelp(): void {
    console.log([
        'RepoGuide Artifact Snapshots',
        '',
        'Usage:',
        '  npm run snapshot:artifacts -- create --repo <path> [--label axios-v1-baseline]',
        '  npm run snapshot:artifacts -- restore --repo <path> --snapshot <id-or-path>',
        '  npm run snapshot:artifacts -- list --repo <path>',
        '',
        'Snapshots are stored under <repo>/.repoguide/snapshots/<snapshot-id>.'
    ].join('\n'));
}
