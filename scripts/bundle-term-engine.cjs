/* Rebuild from a bilingual-term-extract source checkout. No runtime dependencies. */
const fs = require('node:fs'), path = require('node:path');
const source = process.argv[2];
if (!source) throw new Error('Provide the bilingual-term-extract source directory');
const names = ['util', 'stopwords', 'tokenizer', 'candidates', 'vote'];
let out = '/* Vendored bilingual-term-extract statistical engine.\n' + fs.readFileSync(path.join(source, 'LICENSE'), 'utf8') + '\n*/\n';
out += '(function(root){\nconst factories={}, cache={}, process={env:{}};\n';
for (const name of names) out += 'factories[' + JSON.stringify('./' + name + '.js') + ']=function(require,module,exports){\n' + fs.readFileSync(path.join(source, 'scripts/core', name + '.js'), 'utf8') + '\n};\n';
out += 'factories["./validate.js"]=function(require,module,exports){\n' + fs.readFileSync(path.join(source, 'scripts/validate.js'), 'utf8').replace("require('./core/tokenizer.js')", "require('./tokenizer.js')") + '\n};\n';
out += 'function load(id){if(id==="fs")return {};if(!cache[id]){const m={exports:{}};cache[id]=m;factories[id](load,m,m.exports);}return cache[id].exports;}\n';
out += 'const api={...load("./candidates.js"),...load("./vote.js"),...load("./validate.js")};if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.MiniCatTermEngine=api;\n})(typeof globalThis!=="undefined"?globalThis:this);\n';
fs.writeFileSync(path.join(__dirname, '../js/term-engine.js'), out);
