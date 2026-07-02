import * as fs from 'fs';
import * as path from 'path';
import * as moduleObj from 'module';

interface CliArgs {
    repo: string;
    questions: string;
    threshold: number;
    repoProvided: boolean;
    prepare: boolean;
    useExistingArtifacts: boolean;
    shadowEval: boolean;
    output?: string;
    help: boolean;
}

installVscodeShim();

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
});

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const { MiniEvalRunner } = await import('./miniEvalRunner.js');
    const runner = new MiniEvalRunner();
    const artifacts = await runner.run({
        repoPath: args.repo,
        questionsPath: args.questions,
        threshold: args.threshold,
        prepare: args.prepare,
        useExistingArtifacts: args.useExistingArtifacts,
        shadowEval: args.shadowEval,
        outputDir: args.output
    });

    console.log('');
    console.log(`RepoGuide mini eval ${artifacts.result.summary.passed ? 'PASS' : 'FAIL'}`);
    console.log(`Overall score: ${Math.round(artifacts.result.summary.overallScore * 100)}%`);
    console.log(`Mode: ${artifacts.result.evaluationMode}`);
    console.log(`Repo: ${artifacts.result.repoPath}`);
    console.log(`Dataset: ${artifacts.result.questionSetName}`);
    console.log(`JSON report: ${artifacts.jsonPath}`);
    console.log(`Markdown report: ${artifacts.markdownPath}`);

    if (!artifacts.result.summary.passed) {
        process.exit(1);
    }
    process.exit(0);
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        repo: '',
        questions: defaultQuestionsPath(),
        threshold: 0.8,
        repoProvided: false,
        prepare: false,
        useExistingArtifacts: false,
        shadowEval: false,
        help: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--repo':
                args.repo = requireValue(arg, next);
                args.repoProvided = true;
                i += 1;
                break;
            case '--questions':
                args.questions = requireValue(arg, next);
                i += 1;
                break;
            case '--threshold':
                args.threshold = Number(requireValue(arg, next));
                if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
                    throw new Error('--threshold must be a number between 0 and 1');
                }
                i += 1;
                break;
            case '--output':
                args.output = requireValue(arg, next);
                i += 1;
                break;
            case '--prepare':
                args.prepare = true;
                break;
            case '--use-existing-artifacts':
                args.useExistingArtifacts = true;
                break;
            case '--shadow-eval':
                args.shadowEval = true;
                break;
            case '--help':
            case '-h':
                args.help = true;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!args.repoProvided) {
        args.repo = defaultRepoForQuestions(args.questions);
    }
    if (!fs.existsSync(args.repo)) {
        throw new Error(`Repo path does not exist: ${args.repo}`);
    }
    if (!fs.existsSync(args.questions)) {
        throw new Error(`Questions file does not exist: ${args.questions}`);
    }

    return args;
}

function requireValue(flag: string, value: string | undefined): string {
    if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

function defaultRepoForQuestions(questionsPath: string): string {
    try {
        const parsed = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
        if (parsed.targetRepoHint) {
            return path.resolve(__dirname, '../..', parsed.targetRepoHint);
        }
    } catch { }
    throw new Error('No --repo was provided and the selected question set does not define targetRepoHint.');
}

function defaultQuestionsPath(): string {
    return path.resolve(__dirname, '../../test/evaluation/mixed-fullstack.golden.json');
}

function printHelp(): void {
    console.log([
        'RepoGuide Mini Evaluation',
        '',
        'Usage:',
        '  npm run eval:mini -- [--repo <path>] [--questions <json>] [--threshold 0.8] [--prepare]',
        '',
        'Options:',
        '  --repo        Target repository path. Defaults to the selected dataset targetRepoHint.',
        '  --questions   Golden question set JSON. Defaults to test/evaluation/mixed-fullstack.golden.json.',
        '  --threshold   Overall pass threshold, 0..1. Defaults to 0.8.',
        '  --prepare     Rebuild RepoGuide index/comprehension before evaluating.',
        '  --use-existing-artifacts  Use the current .repoguide artifacts without rebuilding comprehension.',
        '  --output      Override output directory. Defaults to <repo>/.repoguide/eval.',
        '  --help        Show this help.'
    ].join('\n'));
}
function installVscodeShim(): void {
    const originalRequire = moduleObj.Module.prototype.require;
    const shim = createVscodeShim();
    moduleObj.Module.prototype.require = function patchedRequire(id: string) {
        if (id === 'vscode') {
            return shim;
        }
        return originalRequire.apply(this, arguments as any);
    };
}

function createVscodeShim(): any {
    const visibleTextEditors: any[] = [];
    return {
        workspace: {
            workspaceFolders: [],
            getConfiguration: () => ({
                get: (_key: string, fallback: unknown) => fallback
            }),
            openTextDocument: async (filePath: string) => {
                const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
                const lines = text.split(/\r?\n/);
                return {
                    uri: { scheme: 'file', fsPath: filePath },
                    lineCount: lines.length,
                    lineAt: (line: number) => ({ text: lines[Math.max(0, Math.min(line, lines.length - 1))] ?? '' }),
                    getText: () => text
                };
            },
            onDidSaveTextDocument: () => disposable(),
            onDidChangeConfiguration: () => disposable(),
            onDidOpenTextDocument: () => disposable(),
            createFileSystemWatcher: () => disposable()
        },
        window: {
            visibleTextEditors,
            createOutputChannel: () => ({
                appendLine: (message: string) => console.log(message),
                show: () => undefined,
                dispose: () => undefined
            }),
            createTextEditorDecorationType: () => disposable(),
            showTextDocument: async (doc: any) => {
                const editor = {
                    document: doc,
                    setDecorations: () => undefined,
                    revealRange: () => undefined
                };
                visibleTextEditors.push(editor);
                return editor;
            },
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async (message: string) => console.error(message),
            showInputBox: async () => undefined,
            showOpenDialog: async () => undefined
        },
        commands: {
            registerCommand: () => disposable(),
            executeCommand: async () => undefined
        },
        extensions: {
            getExtension: () => ({ packageJSON: { version: '0.0.1' } })
        },
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: any, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) })
        },
        Position: class Position {
            constructor(public line: number, public character: number) {}
        },
        Range: class Range {
            constructor(public start: unknown, public end: unknown) {}
        },
        TextEditorRevealType: {
            InCenter: 1,
            InCenterIfOutsideViewport: 2
        },
        ViewColumn: {
            One: 1,
            Two: 2,
            Three: 3
        }
    };
}

function disposable(): { dispose(): void } {
    return { dispose: () => undefined };
}
