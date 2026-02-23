/** Babel config for Jest: transform ESM (import/export) in tests and client/ to CommonJS */
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
};
