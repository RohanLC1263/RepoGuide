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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolIndex = void 0;
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var repoguideLogger_1 = require("../logging/repoguideLogger");
var NOISE_SYMBOLS = new Set([
    't', 'i', 'e', 'n', 'x', 'id', 'db', 'fn', 'cb', 'ok', 'el',
    'eq', 'op', 'fs', 'fp', 'ctx', 'req', 'res', 'err', 'msg',
    'key', 'val', 'obj', 'arr', 'str', 'num', 'idx', 'len', 'tmp', 'ref'
]);
var SymbolIndex = /** @class */ (function () {
    function SymbolIndex() {
        // Map of symbol name -> SymbolEntry[]
        this.symbolMap = new Map();
    }
    SymbolIndex.prototype.setOutputChannel = function (outputChannel) {
        this.outputChannel = outputChannel;
    };
    SymbolIndex.prototype.addSymbols = function (symbols) {
        for (var _i = 0, symbols_1 = symbols; _i < symbols_1.length; _i++) {
            var sym = symbols_1[_i];
            if (sym.name.length < 3) {
                continue;
            }
            if (NOISE_SYMBOLS.has(sym.name.toLowerCase())) {
                continue;
            }
            var list = this.symbolMap.get(sym.name) || [];
            list.push(sym);
            this.symbolMap.set(sym.name, list);
        }
    };
    SymbolIndex.prototype.lookup = function (name) {
        return this.symbolMap.get(name) || [];
    };
    SymbolIndex.prototype.lookupFuzzy = function (name) {
        if (!name || name.length < 3) {
            return [];
        }
        var results = [];
        var seen = new Set();
        var addResults = function (resultsList) {
            for (var _i = 0, resultsList_1 = resultsList; _i < resultsList_1.length; _i++) {
                var r = resultsList_1[_i];
                var uniqueKey = "".concat(r.filePath, ":").concat(r.startLine, ":").concat(r.endLine, ":").concat(r.name);
                if (!seen.has(uniqueKey)) {
                    seen.add(uniqueKey);
                    results.push(r);
                }
            }
        };
        // 1. Exact match
        addResults(this.lookup(name));
        // 2. PascalCase -> snake_case
        // "ConversationAgent" -> "conversation_agent"
        // "LLMRouter" -> "llm_router"
        var toSnake = name
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
            .toLowerCase();
        if (toSnake !== name) {
            addResults(this.lookup(toSnake));
        }
        // 3. snake_case -> PascalCase
        // "conversation_agent" -> "ConversationAgent"
        if (name.includes('_')) {
            var toPascal = name.split('_')
                .filter(function (part) { return part.length > 0; })
                .map(function (part) { return part[0].toUpperCase() + part.slice(1).toLowerCase(); })
                .join('');
            if (toPascal !== name) {
                addResults(this.lookup(toPascal));
            }
        }
        // 4. all-lower stripping (e.g. LLMRouter -> llmrouter)
        var allLower = name.toLowerCase().replace(/_/g, '');
        if (allLower !== name) {
            addResults(this.lookup(allLower));
        }
        // 5. NEW: Partial substring match against all symbol names
        // This is the critical fix — allows "visual" to match "VisualGroundingAgent"
        // Only run if no exact/variant matches were found AND the term is meaningful
        // (length > 5 to avoid false positives from short words like "get" or "test")
        if (results.length === 0 && name.length > 5) {
            var nameLower = name.toLowerCase();
            var partialCount = 0;
            for (var _i = 0, _a = this.symbolMap.entries(); _i < _a.length; _i++) {
                var _b = _a[_i], symbolName = _b[0], entries = _b[1];
                if (partialCount >= 10)
                    break;
                var symbolLower = symbolName.toLowerCase();
                // Match if the search term is a substring of the symbol name AND makes up at least 40% of it
                if (symbolLower.includes(nameLower) && nameLower.length >= symbolLower.length * 0.4) {
                    addResults(entries);
                    partialCount++;
                }
            }
        }
        return results;
    };
    SymbolIndex.prototype.lookupExact = function (name) {
        var _a;
        var results = [];
        var exactMatches = (_a = this.symbolMap.get(name)) !== null && _a !== void 0 ? _a : [];
        for (var _i = 0, exactMatches_1 = exactMatches; _i < exactMatches_1.length; _i++) {
            var entry = exactMatches_1[_i];
            results.push({ entry: entry, confidence: 1.0 });
        }
        if (results.length === 0) {
            var lower = name.toLowerCase();
            for (var _b = 0, _c = this.symbolMap.entries(); _b < _c.length; _b++) {
                var _d = _c[_b], key = _d[0], entries = _d[1];
                if (key.toLowerCase() === lower) {
                    for (var _e = 0, entries_1 = entries; _e < entries_1.length; _e++) {
                        var entry = entries_1[_e];
                        results.push({ entry: entry, confidence: 0.95 });
                    }
                }
            }
        }
        return results;
    };
    SymbolIndex.prototype.lookupByConceptTokens = function (tokens) {
        var normalizedTokens = tokens
            .map(function (token) { return token.trim(); })
            .filter(Boolean);
        var scoreMap = new Map();
        for (var _i = 0, normalizedTokens_1 = normalizedTokens; _i < normalizedTokens_1.length; _i++) {
            var token = normalizedTokens_1[_i];
            var matches = this.lookupFuzzy(token);
            for (var _a = 0, matches_1 = matches; _a < matches_1.length; _a++) {
                var match = matches_1[_a];
                if (match.name.length < 3 || NOISE_SYMBOLS.has(match.name.toLowerCase())) {
                    continue;
                }
                var key = "".concat(match.filePath, ":").concat(match.startLine, ":").concat(match.endLine, ":").concat(match.name);
                var existing = scoreMap.get(key);
                if (existing) {
                    existing.hits += 1;
                }
                else {
                    scoreMap.set(key, { entry: match, hits: 1 });
                }
            }
        }
        var maxHits = Math.max(normalizedTokens.length, 1);
        return Array.from(scoreMap.values())
            .map(function (item) { return ({
            entry: item.entry,
            confidence: Math.min(0.9, item.hits / maxHits)
        }); })
            .sort(function (a, b) { return b.confidence - a.confidence; });
    };
    SymbolIndex.prototype.save = function (repoguideDir) {
        return __awaiter(this, void 0, void 0, function () {
            var symbolsPath, dir, plainObject, _i, _a, _b, key, val, tempPath, pySymbolCount, e_1;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        _c.trys.push([0, 5, , 6]);
                        symbolsPath = path.join(repoguideDir, 'symbols.json');
                        dir = path.dirname(symbolsPath);
                        if (!!fs.existsSync(dir)) return [3 /*break*/, 2];
                        return [4 /*yield*/, fs.promises.mkdir(dir, { recursive: true })];
                    case 1:
                        _c.sent();
                        _c.label = 2;
                    case 2:
                        plainObject = {};
                        for (_i = 0, _a = this.symbolMap.entries(); _i < _a.length; _i++) {
                            _b = _a[_i], key = _b[0], val = _b[1];
                            plainObject[key] = val;
                        }
                        tempPath = symbolsPath + '.tmp.' + Date.now();
                        return [4 /*yield*/, fs.promises.writeFile(tempPath, JSON.stringify(plainObject, null, 2), 'utf-8')];
                    case 3:
                        _c.sent();
                        return [4 /*yield*/, fs.promises.rename(tempPath, symbolsPath)];
                    case 4:
                        _c.sent();
                        pySymbolCount = Array.from(this.symbolMap.values())
                            .flat()
                            .filter(function (s) { return s.filePath.endsWith('.py'); }).length;
                        repoguideLogger_1.RepoGuideLogger.get().debug("Python symbols extracted: ".concat(pySymbolCount));
                        return [3 /*break*/, 6];
                    case 5:
                        e_1 = _c.sent();
                        repoguideLogger_1.RepoGuideLogger.get().error("Failed to save symbols.json: ".concat(e_1));
                        throw e_1;
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    SymbolIndex.prototype.load = function (repoguideDir) {
        return __awaiter(this, void 0, void 0, function () {
            var symbolsPath, content, plainObject, _i, _a, _b, key, val, e_2;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        _c.trys.push([0, 3, , 4]);
                        symbolsPath = path.join(repoguideDir, 'symbols.json');
                        if (!fs.existsSync(symbolsPath)) return [3 /*break*/, 2];
                        return [4 /*yield*/, fs.promises.readFile(symbolsPath, 'utf-8')];
                    case 1:
                        content = _c.sent();
                        plainObject = JSON.parse(content);
                        this.symbolMap.clear();
                        for (_i = 0, _a = Object.entries(plainObject); _i < _a.length; _i++) {
                            _b = _a[_i], key = _b[0], val = _b[1];
                            this.symbolMap.set(key, val);
                        }
                        _c.label = 2;
                    case 2: return [3 /*break*/, 4];
                    case 3:
                        e_2 = _c.sent();
                        repoguideLogger_1.RepoGuideLogger.get().error("Failed to load symbols.json: ".concat(e_2));
                        this.symbolMap.clear();
                        throw e_2;
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    SymbolIndex.prototype.removeSymbolsByFile = function (filePath) {
        for (var _i = 0, _a = this.symbolMap.entries(); _i < _a.length; _i++) {
            var _b = _a[_i], key = _b[0], symbols = _b[1];
            var filtered = symbols.filter(function (s) { return s.filePath !== filePath; });
            if (filtered.length === 0) {
                this.symbolMap.delete(key);
            }
            else {
                this.symbolMap.set(key, filtered);
            }
        }
    };
    SymbolIndex.prototype.clear = function () {
        this.symbolMap.clear();
    };
    SymbolIndex.prototype.getAllSymbols = function () {
        var all = [];
        for (var _i = 0, _a = this.symbolMap.values(); _i < _a.length; _i++) {
            var symbols = _a[_i];
            all.push.apply(all, symbols);
        }
        var seen = new Set();
        return all.filter(function (sym) {
            var key = "".concat(sym.filePath, ":").concat(sym.startLine);
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    };
    SymbolIndex.prototype.getStats = function () {
        var totalSymbols = 0;
        var fileSet = new Set();
        for (var _i = 0, _a = this.symbolMap.values(); _i < _a.length; _i++) {
            var symbols = _a[_i];
            totalSymbols += symbols.length;
            for (var _b = 0, symbols_2 = symbols; _b < symbols_2.length; _b++) {
                var sym = symbols_2[_b];
                fileSet.add(sym.filePath);
            }
        }
        return {
            totalSymbols: totalSymbols,
            totalFiles: fileSet.size
        };
    };
    SymbolIndex.prototype.hasNoiseSymbols = function () {
        for (var _i = 0, _a = this.symbolMap.entries(); _i < _a.length; _i++) {
            var name_1 = _a[_i][0];
            if (name_1.length < 3 || NOISE_SYMBOLS.has(name_1.toLowerCase())) {
                return true;
            }
        }
        return false;
    };
    return SymbolIndex;
}());
exports.SymbolIndex = SymbolIndex;
