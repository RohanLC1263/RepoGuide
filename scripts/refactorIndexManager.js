const fs = require('fs');

let file = 'src/indexing/indexManager.ts';
let text = fs.readFileSync(file, 'utf8');

text = text.replace(/import \* as vscode from 'vscode';\r?\n/, '');
text = text.replace(/import \{ getGlobalVSCodeContext \} from '\.\.\/context\/vscodeContext';\r?\n/, '');
text = "import { RepositoryContext } from '../context/repositoryContext';\n" + text;

text = text.replace(/private outputChannel: vscode\.OutputChannel,/g, 'private context: RepositoryContext,');
text = text.replace(/this\.outputChannel\.appendLine/g, 'this.context.logger.appendLine');
text = text.replace(/vscode\.window\.showWarningMessage/g, 'this.context.notifyWarning');

fs.writeFileSync(file, text, 'utf8');

let extFile = 'src/extension.ts';
let extText = fs.readFileSync(extFile, 'utf8');
extText = extText.replace(/const indexManager = new IndexManager\([\s\S]*?outputChannel,/g, match => match.replace('outputChannel,', 'getGlobalVSCodeContext(),'));
fs.writeFileSync(extFile, extText, 'utf8');

console.log("Done");
