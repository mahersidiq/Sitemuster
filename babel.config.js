// Babel is used by Metro (app bundles) and jest-expo (mobile Jest tests).
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
