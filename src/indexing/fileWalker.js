"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOWED_EXTENSIONS = void 0;
exports.getUserExcludePatterns = getUserExcludePatterns;
exports.getAllIgnorePatterns = getAllIgnorePatterns;
exports.isWalkableFile = isWalkableFile;
exports.isIgnoredPath = isIgnoredPath;
exports.isIgnoredByPatterns = isIgnoredByPatterns;
exports.walkFiles = walkFiles;
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var ignore_1 = __importDefault(require("ignore"));
var DEFAULT_IGNORES = [
    'node_modules', '.git', 'dist', 'out', 'build', 'coverage',
    '.repoguide', '.venv', 'venv', 'env', '__pycache__',
    '.pytest_cache', '.mypy_cache', '.ruff_cache', '.next',
    '.turbo', 'target', 'local_models', '_local_models',
    'artifacts', 'logs', '*.min.js', '*.map', '*.lock',
    'package-lock.json',
    // Additional exclusions for messy real-world repos
    '_archive', 'archive', 'backup', 'backups',
    'migrations', 'temp', 'tmp', 'scratch',
    '*.backup.py', '*.backup.ts', '*.bak',
    'debug_*', 'manual_*', 'test_*'
];
exports.ALLOWED_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.h', '.kt', '.rb', '.cs', '.php', '.swift', '.md'
]);
/**
 * Reads user-configured exclude patterns from repoguide.excludePatterns.
 * Uses dynamic require so the module can still be loaded outside VS Code
 * (e.g. in mocha unit tests), returning an empty array in that case.
 */
function getUserExcludePatterns() {
    try {
        // Dynamic require avoids hard crash when vscode is unavailable
        var vscode = require('vscode');
        var config = vscode.workspace.getConfiguration('repoguide');
        return config.get('excludePatterns', []);
    }
    catch (_a) {
        return [];
    }
}
/**
 * Merges DEFAULT_IGNORES with user-configured exclude patterns.
 */
function getAllIgnorePatterns() {
    var userPatterns = getUserExcludePatterns();
    var merged = __spreadArray([], DEFAULT_IGNORES, true);
    for (var _i = 0, userPatterns_1 = userPatterns; _i < userPatterns_1.length; _i++) {
        var p = userPatterns_1[_i];
        if (p && !merged.includes(p)) {
            merged.push(p);
        }
    }
    return merged;
}
/**
 * Returns true if the given file path has an allowed extension for indexing.
 */
function isWalkableFile(filePath) {
    var ext = path.extname(filePath).toLowerCase();
    return exports.ALLOWED_EXTENSIONS.has(ext);
}
/**
 * Returns true if the file path matches an ignored pattern.
 * Checks both DEFAULT_IGNORES and user-configured repoguide.excludePatterns.
 * Handles both directory-style patterns (e.g. "vendor") and glob-style
 * patterns (e.g. "*.min.js").
 */
function isIgnoredPath(filePath, workspaceRoot) {
    var normalized = filePath.replace(/\\/g, '/');
    var rootNormalized = workspaceRoot.replace(/\\/g, '/');
    var relative = normalized.startsWith(rootNormalized + '/')
        ? normalized.slice(rootNormalized.length + 1)
        : normalized;
    var allPatterns = getAllIgnorePatterns();
    return isIgnoredByPatterns(relative, allPatterns);
}
/**
 * Pure helper for testing: checks if a relative path matches a set of
 * ignore patterns. Does not read VS Code settings.
 */
function isIgnoredByPatterns(relativePath, patterns) {
    var normalized = relativePath.replace(/\\/g, '/');
    for (var _i = 0, patterns_1 = patterns; _i < patterns_1.length; _i++) {
        var pattern = patterns_1[_i];
        if (!pattern.includes('*')) {
            if (normalized === pattern ||
                normalized.startsWith(pattern + '/') ||
                normalized.includes('/' + pattern + '/') ||
                normalized.endsWith('/' + pattern)) {
                return true;
            }
        }
        // Glob-style pattern: use the ignore library for matching.
        if (pattern.includes('*')) {
            var ig = (0, ignore_1.default)().add(pattern);
            if (ig.ignores(normalized)) {
                return true;
            }
        }
    }
    return false;
}
function walkFiles(rootPath) {
    return __awaiter(this, void 0, void 0, function () {
        function walk(dir, relativeDir) {
            return __awaiter(this, void 0, void 0, function () {
                var entries, _i, entries_1, entry, relativePath, fullPath, checkPath, ext;
                return __generator(this, function (_a) {
                    switch (_a.label) {
                        case 0: return [4 /*yield*/, fs.promises.readdir(dir, { withFileTypes: true })];
                        case 1:
                            entries = _a.sent();
                            _i = 0, entries_1 = entries;
                            _a.label = 2;
                        case 2:
                            if (!(_i < entries_1.length)) return [3 /*break*/, 6];
                            entry = entries_1[_i];
                            relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
                            fullPath = path.join(dir, entry.name);
                            checkPath = relativePath.split(path.sep).join('/');
                            if (!entry.isDirectory()) return [3 /*break*/, 4];
                            if (ig.ignores(checkPath + '/')) {
                                return [3 /*break*/, 5];
                            }
                            return [4 /*yield*/, walk(fullPath, relativePath)];
                        case 3:
                            _a.sent();
                            return [3 /*break*/, 5];
                        case 4:
                            if (entry.isFile()) {
                                if (ig.ignores(checkPath)) {
                                    return [3 /*break*/, 5];
                                }
                                ext = path.extname(entry.name).toLowerCase();
                                if (exports.ALLOWED_EXTENSIONS.has(ext)) {
                                    filePaths.push(fullPath);
                                }
                            }
                            _a.label = 5;
                        case 5:
                            _i++;
                            return [3 /*break*/, 2];
                        case 6: return [2 /*return*/];
                    }
                });
            });
        }
        var allPatterns, ig, gitignorePath, gitignoreContent, e_1, filePaths, MAX_FILES;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    allPatterns = getAllIgnorePatterns();
                    ig = (0, ignore_1.default)().add(allPatterns);
                    gitignorePath = path.join(rootPath, '.gitignore');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, fs.promises.readFile(gitignorePath, 'utf-8')];
                case 2:
                    gitignoreContent = _a.sent();
                    ig.add(gitignoreContent);
                    return [3 /*break*/, 4];
                case 3:
                    e_1 = _a.sent();
                    return [3 /*break*/, 4];
                case 4:
                    filePaths = [];
                    return [4 /*yield*/, walk(rootPath, '')];
                case 5:
                    _a.sent();
                    MAX_FILES = 2000;
                    if (filePaths.length > MAX_FILES) {
                        console.warn("RepoGuide: ".concat(filePaths.length, " files found, limiting to ").concat(MAX_FILES));
                        // Prioritize by directory depth (shallower = more important)
                        filePaths.sort(function (a, b) { return a.split(path.sep).length - b.split(path.sep).length; });
                        return [2 /*return*/, filePaths.slice(0, MAX_FILES)];
                    }
                    return [2 /*return*/, filePaths];
            }
        });
    });
}
