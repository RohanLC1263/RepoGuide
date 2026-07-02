/// <reference path="../../node_modules/node-tree-sitter/tree-sitter.d.ts" />

declare module 'node-tree-sitter' {
    import Parser = require('tree-sitter');
    export = Parser;
}
