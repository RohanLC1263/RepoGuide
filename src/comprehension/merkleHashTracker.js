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
exports.MerkleHashTracker = void 0;
var fs = __importStar(require("fs"));
var path = __importStar(require("path"));
var crypto = __importStar(require("crypto"));
/**
 * Tracks file content hashes for incremental annotation.
 * A file needs re-annotation only when its hash changes.
 * Stores the registry at .repoguide/file_hashes.json
 */
var MerkleHashTracker = /** @class */ (function () {
    function MerkleHashTracker(repoguideDir) {
        this.registry = {};
        this.dirty = false;
        this.registryPath = path.join(repoguideDir, 'file_hashes.json');
    }
    /**
     * Load the hash registry from disk.
     */
    MerkleHashTracker.prototype.init = function () {
        return __awaiter(this, void 0, void 0, function () {
            var raw, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        if (!fs.existsSync(this.registryPath)) return [3 /*break*/, 4];
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, fs.promises.readFile(this.registryPath, 'utf8')];
                    case 2:
                        raw = _b.sent();
                        this.registry = JSON.parse(raw);
                        return [3 /*break*/, 4];
                    case 3:
                        _a = _b.sent();
                        this.registry = {};
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Compute sha256 hash of file content.
     */
    MerkleHashTracker.prototype.computeHash = function (content) {
        return crypto.createHash('sha256').update(content).digest('hex');
    };
    /**
     * Check if a file's content has changed since we last recorded its hash.
     * Returns true if the file is new or its content has changed.
     */
    MerkleHashTracker.prototype.hasChanged = function (filePath, content) {
        var currentHash = this.computeHash(content);
        var storedHash = this.registry[filePath];
        return storedHash !== currentHash;
    };
    /**
     * Update the stored hash for a file after successful annotation.
     */
    MerkleHashTracker.prototype.updateHash = function (filePath, content) {
        this.registry[filePath] = this.computeHash(content);
        this.dirty = true;
    };
    /**
     * Get the stored hash for a file (used for annotation file naming).
     */
    MerkleHashTracker.prototype.getHash = function (filePath, content) {
        return this.computeHash(content);
    };
    /**
     * From a list of file paths and their contents, return only those
     * whose content has changed since last annotation.
     */
    MerkleHashTracker.prototype.getChangedFiles = function (files) {
        var _this = this;
        return files
            .filter(function (f) { return _this.hasChanged(f.filePath, f.content); })
            .map(function (f) { return f.filePath; });
    };
    /**
     * Remove a file from the hash registry (e.g. when file is deleted).
     */
    MerkleHashTracker.prototype.removeFile = function (filePath) {
        delete this.registry[filePath];
        this.dirty = true;
    };
    /**
     * Persist the registry to disk if there are pending changes.
     */
    MerkleHashTracker.prototype.save = function () {
        return __awaiter(this, void 0, void 0, function () {
            var dir;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!this.dirty)
                            return [2 /*return*/];
                        dir = path.dirname(this.registryPath);
                        return [4 /*yield*/, fs.promises.mkdir(dir, { recursive: true })];
                    case 1:
                        _a.sent();
                        return [4 /*yield*/, fs.promises.writeFile(this.registryPath, JSON.stringify(this.registry, null, 2), 'utf8')];
                    case 2:
                        _a.sent();
                        this.dirty = false;
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Clear all tracked hashes.
     */
    MerkleHashTracker.prototype.clear = function () {
        this.registry = {};
        this.dirty = true;
    };
    /**
     * Get the total number of tracked files.
     */
    MerkleHashTracker.prototype.getTrackedCount = function () {
        return Object.keys(this.registry).length;
    };
    return MerkleHashTracker;
}());
exports.MerkleHashTracker = MerkleHashTracker;
