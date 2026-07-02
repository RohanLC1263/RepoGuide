"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectLanguage = detectLanguage;
exports.getTreeSitterLanguage = getTreeSitterLanguage;
function detectLanguage(filePath) {
    var _a;
    var ext = (_a = filePath.split('.').pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase();
    switch (ext) {
        case 'ts':
        case 'tsx': return 'typescript';
        case 'js':
        case 'jsx': return 'javascript';
        case 'py': return 'python';
        case 'java': return 'java';
        case 'go': return 'go';
        case 'rs': return 'rust';
        case 'cpp':
        case 'c':
        case 'h': return 'cpp';
        case 'kt': return 'java';
        case 'md': return 'markdown';
        default: return null;
    }
}
function getTreeSitterLanguage(language) {
    var _a, _b, _c, _d, _e;
    try {
        switch (language) {
            case 'typescript':
            case 'javascript':
                return require('tree-sitter-typescript').typescript;
            case 'python':
                return (_a = require('tree-sitter-python').python) !== null && _a !== void 0 ? _a : require('tree-sitter-python');
            case 'java':
                return (_b = require('tree-sitter-java').java) !== null && _b !== void 0 ? _b : require('tree-sitter-java');
            case 'go':
                return (_c = require('tree-sitter-go').go) !== null && _c !== void 0 ? _c : require('tree-sitter-go');
            case 'rust':
                return (_d = require('tree-sitter-rust').rust) !== null && _d !== void 0 ? _d : require('tree-sitter-rust');
            case 'cpp':
                return (_e = require('tree-sitter-cpp').cpp) !== null && _e !== void 0 ? _e : require('tree-sitter-cpp');
            default:
                return null;
        }
    }
    catch (e) {
        return null;
    }
}
