const vscode = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    onDidSaveTextDocument: () => ({ dispose: () => undefined }),
    onDidCreateFiles: () => ({ dispose: () => undefined }),
    onDidDeleteFiles: () => ({ dispose: () => undefined }),
    onDidRenameFiles: () => ({ dispose: () => undefined }),
    findFiles: async () => []
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined
    }),
    showErrorMessage: () => undefined,
    showInformationMessage: () => undefined,
    withProgress: async (_opts: unknown, task: (p: unknown) => Promise<unknown>) => task({ report: () => undefined }),
    createWebviewPanel: () => {
      throw new Error('createWebviewPanel not mocked for this test -- override vscode.window.createWebviewPanel before use');
    }
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const path = require('path');
      return { fsPath: path.join(base.fsPath, ...parts), scheme: 'file' };
    }
  },
  ProgressLocation: { Notification: 15 },
  EventEmitter: class {
    event = () => ({ dispose: () => undefined });
    fire() {}
    dispose() {}
  },
  ExtensionContext: class {},
  commands: {
    registerCommand: () => ({ dispose: () => undefined }),
    executeCommand: async () => undefined
  },
  Disposable: { from: () => ({ dispose: () => undefined }) }
};

module.exports = vscode;
