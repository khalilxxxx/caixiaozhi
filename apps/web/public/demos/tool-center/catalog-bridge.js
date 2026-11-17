import * as model from './model.js';
// Loaded as a native module script so Vite does not rewrite public asset imports.
Object.defineProperty(window, Symbol.for('caixiaozhi.tool-catalog.model'), {value:model, configurable:true});
