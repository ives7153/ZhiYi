/** Run with: node scripts/verify/button-contrast.mjs (no emulator required). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../', import.meta.url);
const files = [
  'app/(tabs)/outfits.tsx',
  'src/components/SaveOutfitModal.tsx',
  'src/components/LocationCityModal.tsx',
];
const tokensSource = readFileSync(new URL('src/theme/tokens.ts', root), 'utf8');
const tokens = { exports: {} };
vm.runInNewContext(ts.transpileModule(tokensSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, {
  exports: tokens.exports,
  require: () => ({ Platform: { select: (options) => options.android } }),
});

function flatten(style) {
  return Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten))
    : style || {};
}

function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i, `Expected opaque theme color, got ${hex}`);
  const channels = hex.slice(1).match(/../g).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

let checks = 0;
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, root), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const stylesDeclaration = nodes.find((node) =>
    ts.isVariableDeclaration(node) && node.name.getText(source) === 'styles');
  const styles = vm.runInNewContext(`(${stylesDeclaration.initializer.arguments[0].getText(source)})`,
    { StyleSheet: { hairlineWidth: 1 } });
  function attribute(node, name) {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const attr = opening.attributes.properties.find((prop) => prop.name?.getText(source) === name);
    return attr?.initializer && (ts.isJsxExpression(attr.initializer)
      ? attr.initializer.expression : attr.initializer);
  }
  function tag(node) {
    return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(source);
  }
  const buttons = nodes.filter((node) => ts.isJsxElement(node) && tag(node) === 'Pressable'
    && attribute(node, 'style')?.getText(source).includes('colors.primary'));
  assert.ok(buttons.length > 0, `${file}: expected primary buttons`);
  for (const [theme, colors] of [['light', tokens.exports.lightColors], ['dark', tokens.exports.darkColors]]) {
    let themeChecks = 0;
    for (const state of [false, true]) {
      const context = { styles, colors, radius: tokens.exports.radius, isSelected: state,
        isFullBodyMode: state, draft: { selection: { outer: state, accessory: state } } };
      const evaluate = (expression) => vm.runInNewContext(`(${expression.getText(source)})`, context);
      for (const button of buttons) {
        const background = flatten(evaluate(attribute(button, 'style'))).backgroundColor;
        if (background !== colors.primary) continue;
        function checkContent(node) {
          if (ts.isJsxElement(node) && tag(node) === 'Text') {
            const expression = attribute(node, 'style');
            const foreground = expression && flatten(evaluate(expression)).color;
            assert.ok(foreground, `${file}: primary button text must set its color`);
            assert.ok(contrast(background, foreground) >= 4.5,
              `${file} (${theme}): text ${foreground} on ${background} has insufficient contrast`);
            checks++;
            themeChecks++;
          } else if (ts.isJsxSelfClosingElement(node) && tag(node) === 'ActivityIndicator') {
            const foreground = evaluate(attribute(node, 'color'));
            assert.ok(contrast(background, foreground) >= 3,
              `${file} (${theme}): loading indicator is not visible`);
            checks++;
            themeChecks++;
          }
          ts.forEachChild(node, checkContent);
        }
        checkContent(button);
      }
    }
    assert.ok(themeChecks > 0, `${file}: no ${theme} button content checked`);
    console.log(`PASS ${file} (${theme}): ${themeChecks} text/loading checks`);
  }
}
console.log(`PASS: ${checks} primary-button contrast checks across light/dark and selected states`);
