export function detectLanguage(filePath: string): string | null {
    // Infra/deployment files are conventionally bare or dotfile-prefixed
    // (Dockerfile, Makefile, .env[.example]), so path.extname()/split('.').pop()
    // either returns nothing useful or the wrong segment entirely -- these need
    // a basename check before falling through to the extension switch below.
    // No tree-sitter grammar exists for any of these (same as Ruby/PHP/Swift),
    // so they fall back to plain-text chunking exactly the way those already do
    // -- this only makes them indexable at all, not AST-parsed.
    const basename = (filePath.split(/[\\/]/).pop() ?? '').toLowerCase();
    if (basename === 'dockerfile' || basename.startsWith('dockerfile.')) {
        return 'dockerfile';
    }
    if (basename === 'makefile') {
        return 'makefile';
    }
    if (basename === '.env' || basename.startsWith('.env.')) {
        return 'dotenv';
    }

    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'ts':
        case 'tsx': return 'typescript';
        case 'js':
        case 'jsx': return 'javascript';
        case 'py': return 'python';
        case 'java': return 'java';
        case 'go': return 'go';
        case 'rs': return 'rust';
        case 'rb': return 'ruby';
        case 'php': return 'php';
        case 'cs': return 'csharp';
        case 'swift': return 'swift';
        case 'cpp':
        case 'c':
        case 'h': return 'cpp';
        case 'kt': return 'java';
        case 'md': return 'markdown';
        case 'yaml':
        case 'yml': return 'yaml';
        default: return null;
    }
}

export function getTreeSitterLanguage(language: string): any | null {
    try {
        switch (language) {
            case 'typescript':
            case 'javascript':
                return require('tree-sitter-typescript').typescript;
            case 'python':
                return require('tree-sitter-python').python 
                    ?? require('tree-sitter-python');
            case 'java':
                return require('tree-sitter-java').java 
                    ?? require('tree-sitter-java');
            case 'go':
                return require('tree-sitter-go').go 
                    ?? require('tree-sitter-go');
            case 'rust':
                return require('tree-sitter-rust').rust 
                    ?? require('tree-sitter-rust');
            case 'cpp':
                return require('tree-sitter-cpp').cpp
                    ?? require('tree-sitter-cpp');
            case 'csharp':
                // tree-sitter-c-sharp's package export shape differs from
                // every other grammar here: the whole module object (not a
                // named sub-property) must be passed to Parser.setLanguage(),
                // since node-tree-sitter's node-subclassing reads
                // language.nodeTypeInfo directly off whatever was passed in.
                // Confirmed via direct testing -- passing `.language` alone
                // parses but then throws later when walking the tree.
                return require('tree-sitter-c-sharp');
            default:
                return null;
        }
    } catch (e) {
        return null;
    }
}
