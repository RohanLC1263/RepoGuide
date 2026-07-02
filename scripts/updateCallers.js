const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        let isDirectory = fs.statSync(dirPath).isDirectory();
        isDirectory ? walkDir(dirPath, callback) : callback(dirPath);
    });
}

walkDir('src', (filePath) => {
    if (!filePath.endsWith('.ts')) return;
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // Check for streamChat
    if (content.includes('streamChat(')) {
        if (!content.includes('import { getGlobalVSCodeContext }')) {
            let relPath = path.relative(path.dirname(filePath), 'src/context/vscodeContext').replace(/\\/g, '/');
            content = `import { getGlobalVSCodeContext } from '${relPath}';\n` + content;
        }
        content = content.replace(/streamChat\((?!context)(?!getGlobalVSCodeContext)/g, 'streamChat(getGlobalVSCodeContext(), ');
        modified = true;
    }

    // Check for embedText
    if (content.includes('embedText(') && !filePath.endsWith('embedder.ts')) {
        if (!content.includes('import { getGlobalVSCodeContext }')) {
            let relPath = path.relative(path.dirname(filePath), 'src/context/vscodeContext').replace(/\\/g, '/');
            content = `import { getGlobalVSCodeContext } from '${relPath}';\n` + content;
        }
        content = content.replace(/embedText\((?!context)(?!getGlobalVSCodeContext)/g, 'embedText(getGlobalVSCodeContext(), ');
        modified = true;
    }

    // Check for streamGenerate
    if (content.includes('streamGenerate(') && !filePath.endsWith('ollamaClient.ts')) {
        if (!content.includes('import { getGlobalVSCodeContext }')) {
            let relPath = path.relative(path.dirname(filePath), 'src/context/vscodeContext').replace(/\\/g, '/');
            content = `import { getGlobalVSCodeContext } from '${relPath}';\n` + content;
        }
        content = content.replace(/streamGenerate\((?!context)(?!getGlobalVSCodeContext)/g, 'streamGenerate(getGlobalVSCodeContext(), ');
        modified = true;
    }

    if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log('Updated', filePath);
    }
});
