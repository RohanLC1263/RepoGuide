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
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileAnnotationEngine = void 0;
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var crypto = __importStar(require("crypto"));
var inferencer_1 = require("../ollama/inferencer");
// ── Valid enums ────────────────────────────────────────────────────────────
var VALID_ROLES = new Set([
    'entry_point', 'route_handler', 'service', 'model',
    'middleware', 'repository', 'utility', 'configuration',
    'interface', 'test', 'event_handler', 'worker', 'other'
]);
var VALID_SIGNALS = new Set([
    'mutates_state', 'external_call', 'async_pattern',
    'error_boundary', 'security_sensitive', 'side_effects',
    'performance_critical'
]);
var VALID_CONFIDENCES = new Set(['high', 'medium', 'low']);
// ── Engine ─────────────────────────────────────────────────────────────────
var FileAnnotationEngine = /** @class */ (function () {
    function FileAnnotationEngine(repoguideDir, workspaceRoot, outputChannel) {
        this.repoguideDir = repoguideDir;
        this.workspaceRoot = workspaceRoot;
        this.outputChannel = outputChannel;
        this.annotationsDir = path.join(repoguideDir, 'annotations');
    }
    /**
     * Truncate file content for the LLM prompt:
     * - If over 200 lines: first 150 lines + last 20 lines
     * - Otherwise: full content
     */
    FileAnnotationEngine.prototype.truncateContent = function (content) {
        var lines = content.split('\n');
        if (lines.length <= 200) {
            return content;
        }
        var head = lines.slice(0, 150).join('\n');
        var tail = lines.slice(-20).join('\n');
        return "".concat(head, "\n\n... (").concat(lines.length - 170, " lines omitted) ...\n\n").concat(tail);
    };
    /**
     * Detect a simple project type from workspace root heuristics.
     */
    FileAnnotationEngine.prototype.detectProjectType = function () {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        try {
            var pkgPath = path.join(this.workspaceRoot, 'package.json');
            if (fs.existsSync(pkgPath)) {
                var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (((_a = pkg.dependencies) === null || _a === void 0 ? void 0 : _a.next) || ((_b = pkg.devDependencies) === null || _b === void 0 ? void 0 : _b.next))
                    return 'Next.js application';
                if (((_c = pkg.dependencies) === null || _c === void 0 ? void 0 : _c.express) || ((_d = pkg.devDependencies) === null || _d === void 0 ? void 0 : _d.express))
                    return 'Express.js application';
                if (((_e = pkg.dependencies) === null || _e === void 0 ? void 0 : _e.react) || ((_f = pkg.devDependencies) === null || _f === void 0 ? void 0 : _f.react))
                    return 'React application';
                if (((_g = pkg.dependencies) === null || _g === void 0 ? void 0 : _g.vue) || ((_h = pkg.devDependencies) === null || _h === void 0 ? void 0 : _h.vue))
                    return 'Vue.js application';
                if (pkg.main || pkg.exports)
                    return 'Node.js library';
                return 'Node.js project';
            }
            if (fs.existsSync(path.join(this.workspaceRoot, 'setup.py')) ||
                fs.existsSync(path.join(this.workspaceRoot, 'pyproject.toml'))) {
                return 'Python project';
            }
            if (fs.existsSync(path.join(this.workspaceRoot, 'Cargo.toml')))
                return 'Rust project';
            if (fs.existsSync(path.join(this.workspaceRoot, 'go.mod')))
                return 'Go project';
        }
        catch ( /* ignore */_j) { /* ignore */ }
        return 'software project';
    };
    /**
     * Build the LLM prompt for annotation.
     */
    FileAnnotationEngine.prototype.buildPrompt = function (filePath, content) {
        var relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
        var projectType = this.detectProjectType();
        var truncated = this.truncateContent(content);
        var systemPrompt = "You are analyzing a source code file to produce a structured annotation. You must respond with ONLY a JSON object. No text before or after. No markdown. No explanation. Start your response with { and end it with }.";
        var userPrompt = "File path: ".concat(relPath, "\nProject type: ").concat(projectType, "\n\nFile content:\n").concat(truncated, "\n\nProduce this exact JSON:\n{\n  \"what\": \"one sentence max 120 chars describing what this file does in project context\",\n  \"role\": \"choose exactly one from: entry_point, route_handler, service, model, middleware, repository, utility, configuration, interface, test, event_handler, worker, other\",\n  \"key_symbols\": [\"up to 8 names defined here that other files would import\"],\n  \"depends_on\": [\"up to 12 names this file uses from other project files\"],\n  \"signals\": [\"applicable signals only from: mutates_state, external_call, async_pattern, error_boundary, security_sensitive, side_effects, performance_critical\"],\n  \"confidence\": \"high if clear, medium if uncertain, low if short or generated\"\n}\n\nRules:\n- what must describe purpose not syntax\n- key_symbols must be names not descriptions\n- depends_on must be names not import paths\n- signals must only use the listed values\n- role must be exactly one listed value\n- test files always get role test\n- files under 10 lines always get confidence low");
        return [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];
    };
    /**
     * Call the LLM and collect the full response.
     */
    FileAnnotationEngine.prototype.callLLM = function (messages) {
        return __awaiter(this, void 0, void 0, function () {
            var result, _a, _b, _c, chunk, e_1_1;
            var _d, e_1, _e, _f;
            return __generator(this, function (_g) {
                switch (_g.label) {
                    case 0:
                        result = '';
                        _g.label = 1;
                    case 1:
                        _g.trys.push([1, 6, 7, 12]);
                        _a = true, _b = __asyncValues((0, inferencer_1.streamChat)(messages));
                        _g.label = 2;
                    case 2: return [4 /*yield*/, _b.next()];
                    case 3:
                        if (!(_c = _g.sent(), _d = _c.done, !_d)) return [3 /*break*/, 5];
                        _f = _c.value;
                        _a = false;
                        chunk = _f;
                        result += chunk;
                        _g.label = 4;
                    case 4:
                        _a = true;
                        return [3 /*break*/, 2];
                    case 5: return [3 /*break*/, 12];
                    case 6:
                        e_1_1 = _g.sent();
                        e_1 = { error: e_1_1 };
                        return [3 /*break*/, 12];
                    case 7:
                        _g.trys.push([7, , 10, 11]);
                        if (!(!_a && !_d && (_e = _b.return))) return [3 /*break*/, 9];
                        return [4 /*yield*/, _e.call(_b)];
                    case 8:
                        _g.sent();
                        _g.label = 9;
                    case 9: return [3 /*break*/, 11];
                    case 10:
                        if (e_1) throw e_1.error;
                        return [7 /*endfinally*/];
                    case 11: return [7 /*endfinally*/];
                    case 12: return [2 /*return*/, result.trim()];
                }
            });
        });
    };
    /**
     * Parse a JSON response from the LLM, with retry on failure.
     */
    FileAnnotationEngine.prototype.parseWithRetry = function (messages, relPath) {
        return __awaiter(this, void 0, void 0, function () {
            var attempt, raw, firstBrace, lastBrace, parsed, e_2;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        console.log("[DEBUG] Prompt for ".concat(relPath, ":"));
                        console.log(JSON.stringify(messages, null, 2));
                        attempt = 0;
                        _b.label = 1;
                    case 1:
                        if (!(attempt < 2)) return [3 /*break*/, 6];
                        _b.label = 2;
                    case 2:
                        _b.trys.push([2, 4, , 5]);
                        return [4 /*yield*/, this.callLLM(messages)];
                    case 3:
                        raw = _b.sent();
                        console.log("[DEBUG] Raw LLM response (attempt ".concat(attempt + 1, "):"));
                        console.log(raw);
                        // Strip markdown code fences if present
                        raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
                        firstBrace = raw.indexOf('{');
                        lastBrace = raw.lastIndexOf('}');
                        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
                            raw = raw.substring(firstBrace, lastBrace + 1);
                        }
                        parsed = JSON.parse(raw);
                        if (typeof parsed === 'object' && parsed !== null) {
                            console.log("[DEBUG] JSON parsing succeeded.");
                            return [2 /*return*/, parsed];
                        }
                        return [3 /*break*/, 5];
                    case 4:
                        e_2 = _b.sent();
                        console.log("[DEBUG] LLM call or parse failed: ".concat(e_2));
                        if (attempt === 0) {
                            (_a = this.outputChannel) === null || _a === void 0 ? void 0 : _a.appendLine("[Warn] Annotation JSON parse failed, retrying...");
                        }
                        return [3 /*break*/, 5];
                    case 5:
                        attempt++;
                        return [3 /*break*/, 1];
                    case 6: return [2 /*return*/, null];
                }
            });
        });
    };
    /**
     * Validate and sanitize the parsed LLM response into a proper annotation.
     */
    FileAnnotationEngine.prototype.validate = function (parsed, relPath, hash, lineCount) {
        var failedFields = 0;
        // what
        var what = '';
        if (typeof parsed.what === 'string' && parsed.what.length > 0) {
            what = parsed.what.slice(0, 120);
        }
        else {
            what = "Source file: ".concat(path.basename(relPath));
            failedFields++;
        }
        // role
        var role = 'other';
        if (typeof parsed.role === 'string' && VALID_ROLES.has(parsed.role)) {
            role = parsed.role;
        }
        else {
            failedFields++;
        }
        // Force test role for test files
        var lower = relPath.toLowerCase();
        if (lower.includes('.test.') || lower.includes('.spec.') ||
            lower.includes('__tests__') || lower.includes('/test/') || lower.includes('/tests/')) {
            role = 'test';
        }
        // key_symbols
        var key_symbols = [];
        if (Array.isArray(parsed.key_symbols)) {
            key_symbols = parsed.key_symbols
                .filter(function (s) { return typeof s === 'string' && s.length > 0 && s.length < 100; })
                .slice(0, 8);
        }
        else {
            failedFields++;
        }
        // depends_on
        var depends_on = [];
        if (Array.isArray(parsed.depends_on)) {
            depends_on = parsed.depends_on
                .filter(function (s) { return typeof s === 'string' && s.length > 0 && s.length < 100; })
                .slice(0, 12);
        }
        else {
            failedFields++;
        }
        // signals
        var signals = [];
        if (Array.isArray(parsed.signals)) {
            signals = parsed.signals
                .filter(function (s) { return typeof s === 'string' && VALID_SIGNALS.has(s); });
        }
        else {
            failedFields++;
        }
        // confidence
        var confidence = 'medium';
        if (typeof parsed.confidence === 'string' && VALID_CONFIDENCES.has(parsed.confidence)) {
            confidence = parsed.confidence;
        }
        else {
            failedFields++;
        }
        // Files under 10 lines always get confidence low
        if (lineCount < 10) {
            confidence = 'low';
        }
        // If more than 2 fields failed validation, set confidence to low
        if (failedFields > 2) {
            console.log("[DEBUG] Validation failed: ".concat(failedFields, " fields failed validation. Confidence set to low."));
            confidence = 'low';
        }
        else {
            console.log("[DEBUG] Validation passed. Failed fields: ".concat(failedFields, "."));
        }
        return {
            file: relPath,
            hash: hash,
            generated_at: new Date().toISOString(),
            confidence: confidence,
            what: what,
            role: role,
            key_symbols: key_symbols,
            depends_on: depends_on,
            signals: signals
        };
    };
    /**
     * Annotate a single file. Returns the annotation object.
     */
    FileAnnotationEngine.prototype.annotateFile = function (filePath, content) {
        return __awaiter(this, void 0, void 0, function () {
            var relPath, hash, lineCount, messages, parsed, annotation;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
                        hash = crypto.createHash('sha256').update(content).digest('hex');
                        lineCount = content.split('\n').length;
                        messages = this.buildPrompt(filePath, content);
                        return [4 /*yield*/, this.parseWithRetry(messages, relPath)];
                    case 1:
                        parsed = _b.sent();
                        if (parsed) {
                            annotation = this.validate(parsed, relPath, hash, lineCount);
                            console.log("[DEBUG] Produced validated annotation.");
                        }
                        else {
                            // LLM completely failed — produce a minimal low-confidence annotation
                            console.log("[DEBUG] Fallback triggered because parseWithRetry returned null.");
                            (_a = this.outputChannel) === null || _a === void 0 ? void 0 : _a.appendLine("[Warn] Annotation LLM failed for ".concat(relPath, ", producing minimal annotation"));
                            annotation = {
                                file: relPath,
                                hash: hash,
                                generated_at: new Date().toISOString(),
                                confidence: 'low',
                                what: "Source file: ".concat(path.basename(relPath)),
                                role: 'other',
                                key_symbols: [],
                                depends_on: [],
                                signals: []
                            };
                        }
                        // Persist to disk
                        return [4 /*yield*/, this.saveAnnotation(annotation)];
                    case 2:
                        // Persist to disk
                        _b.sent();
                        return [2 /*return*/, annotation];
                }
            });
        });
    };
    /**
     * Save an annotation to .repoguide/annotations/{file_hash}.json
     */
    FileAnnotationEngine.prototype.saveAnnotation = function (annotation) {
        return __awaiter(this, void 0, void 0, function () {
            var filename, filePath;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, fs.promises.mkdir(this.annotationsDir, { recursive: true })];
                    case 1:
                        _a.sent();
                        filename = "".concat(annotation.hash, ".json");
                        filePath = path.join(this.annotationsDir, filename);
                        return [4 /*yield*/, fs.promises.writeFile(filePath, JSON.stringify(annotation, null, 2), 'utf8')];
                    case 2:
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Load an annotation by file content hash.
     */
    FileAnnotationEngine.prototype.loadAnnotation = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var filePath, raw, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        filePath = path.join(this.annotationsDir, "".concat(hash, ".json"));
                        if (!fs.existsSync(filePath))
                            return [2 /*return*/, null];
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs.promises.readFile(filePath, 'utf8')];
                    case 2:
                        raw = _b.sent();
                        return [2 /*return*/, JSON.parse(raw)];
                    case 3:
                        _a = _b.sent();
                        return [2 /*return*/, null];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Load an annotation by file relative path (scans all annotation files).
     */
    FileAnnotationEngine.prototype.loadAnnotationByPath = function (relPath) {
        return __awaiter(this, void 0, void 0, function () {
            var files, _i, files_1, file, raw, annotation, _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!fs.existsSync(this.annotationsDir))
                            return [2 /*return*/, null];
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 9, , 10]);
                        return [4 /*yield*/, fs.promises.readdir(this.annotationsDir)];
                    case 2:
                        files = _c.sent();
                        _i = 0, files_1 = files;
                        _c.label = 3;
                    case 3:
                        if (!(_i < files_1.length)) return [3 /*break*/, 8];
                        file = files_1[_i];
                        if (!file.endsWith('.json'))
                            return [3 /*break*/, 7];
                        _c.label = 4;
                    case 4:
                        _c.trys.push([4, 6, , 7]);
                        return [4 /*yield*/, fs.promises.readFile(path.join(this.annotationsDir, file), 'utf8')];
                    case 5:
                        raw = _c.sent();
                        annotation = JSON.parse(raw);
                        if (annotation.file === relPath)
                            return [2 /*return*/, annotation];
                        return [3 /*break*/, 7];
                    case 6:
                        _a = _c.sent();
                        return [3 /*break*/, 7];
                    case 7:
                        _i++;
                        return [3 /*break*/, 3];
                    case 8: return [3 /*break*/, 10];
                    case 9:
                        _b = _c.sent();
                        return [3 /*break*/, 10];
                    case 10: return [2 /*return*/, null];
                }
            });
        });
    };
    /**
     * Get all annotations from disk.
     */
    FileAnnotationEngine.prototype.getAllAnnotations = function () {
        return __awaiter(this, void 0, void 0, function () {
            var results, files, _i, files_2, file, raw, _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        if (!fs.existsSync(this.annotationsDir))
                            return [2 /*return*/, []];
                        results = [];
                        _c.label = 1;
                    case 1:
                        _c.trys.push([1, 9, , 10]);
                        return [4 /*yield*/, fs.promises.readdir(this.annotationsDir)];
                    case 2:
                        files = _c.sent();
                        _i = 0, files_2 = files;
                        _c.label = 3;
                    case 3:
                        if (!(_i < files_2.length)) return [3 /*break*/, 8];
                        file = files_2[_i];
                        if (!file.endsWith('.json'))
                            return [3 /*break*/, 7];
                        _c.label = 4;
                    case 4:
                        _c.trys.push([4, 6, , 7]);
                        return [4 /*yield*/, fs.promises.readFile(path.join(this.annotationsDir, file), 'utf8')];
                    case 5:
                        raw = _c.sent();
                        results.push(JSON.parse(raw));
                        return [3 /*break*/, 7];
                    case 6:
                        _a = _c.sent();
                        return [3 /*break*/, 7];
                    case 7:
                        _i++;
                        return [3 /*break*/, 3];
                    case 8: return [3 /*break*/, 10];
                    case 9:
                        _b = _c.sent();
                        return [3 /*break*/, 10];
                    case 10: return [2 /*return*/, results];
                }
            });
        });
    };
    /**
     * Delete annotation for a file by its hash.
     */
    FileAnnotationEngine.prototype.deleteAnnotation = function (hash) {
        return __awaiter(this, void 0, void 0, function () {
            var filePath;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        filePath = path.join(this.annotationsDir, "".concat(hash, ".json"));
                        if (!fs.existsSync(filePath)) return [3 /*break*/, 2];
                        return [4 /*yield*/, fs.promises.unlink(filePath)];
                    case 1:
                        _a.sent();
                        _a.label = 2;
                    case 2: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Clear all annotations.
     */
    FileAnnotationEngine.prototype.clearAll = function () {
        return __awaiter(this, void 0, void 0, function () {
            var files, _i, files_3, file;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!fs.existsSync(this.annotationsDir)) return [3 /*break*/, 5];
                        return [4 /*yield*/, fs.promises.readdir(this.annotationsDir)];
                    case 1:
                        files = _a.sent();
                        _i = 0, files_3 = files;
                        _a.label = 2;
                    case 2:
                        if (!(_i < files_3.length)) return [3 /*break*/, 5];
                        file = files_3[_i];
                        return [4 /*yield*/, fs.promises.unlink(path.join(this.annotationsDir, file))];
                    case 3:
                        _a.sent();
                        _a.label = 4;
                    case 4:
                        _i++;
                        return [3 /*break*/, 2];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Annotate multiple files with concurrency control.
     * Limits concurrent LLM calls to avoid overloading Ollama.
     */
    FileAnnotationEngine.prototype.annotateFiles = function (files_4) {
        return __awaiter(this, arguments, void 0, function (files, concurrency) {
            var results, index, worker, workers;
            var _this = this;
            if (concurrency === void 0) { concurrency = 3; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        results = [];
                        index = 0;
                        worker = function () { return __awaiter(_this, void 0, void 0, function () {
                            var current, _a, filePath, content, annotation, e_3;
                            var _b, _c;
                            return __generator(this, function (_d) {
                                switch (_d.label) {
                                    case 0:
                                        if (!(index < files.length)) return [3 /*break*/, 5];
                                        current = index++;
                                        _a = files[current], filePath = _a.filePath, content = _a.content;
                                        _d.label = 1;
                                    case 1:
                                        _d.trys.push([1, 3, , 4]);
                                        return [4 /*yield*/, this.annotateFile(filePath, content)];
                                    case 2:
                                        annotation = _d.sent();
                                        results.push(annotation);
                                        (_b = this.outputChannel) === null || _b === void 0 ? void 0 : _b.appendLine("[Info] Annotated (".concat(current + 1, "/").concat(files.length, "): ").concat(annotation.file, " [").concat(annotation.role, "] [").concat(annotation.confidence, "]"));
                                        return [3 /*break*/, 4];
                                    case 3:
                                        e_3 = _d.sent();
                                        (_c = this.outputChannel) === null || _c === void 0 ? void 0 : _c.appendLine("[Error] Annotation failed for ".concat(filePath, ": ").concat(e_3));
                                        return [3 /*break*/, 4];
                                    case 4: return [3 /*break*/, 0];
                                    case 5: return [2 /*return*/];
                                }
                            });
                        }); };
                        workers = Array.from({ length: Math.min(concurrency, files.length) }, function () { return worker(); });
                        return [4 /*yield*/, Promise.all(workers)];
                    case 1:
                        _a.sent();
                        return [2 /*return*/, results];
                }
            });
        });
    };
    return FileAnnotationEngine;
}());
exports.FileAnnotationEngine = FileAnnotationEngine;
