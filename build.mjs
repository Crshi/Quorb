/* quorb · 构建脚本
 * 唯一需要打包的入口是 content script（经典内容脚本不支持 ESM import），
 * 产物 dist/content/index.js 由 manifest.json 引用。
 * 不压缩：保持产物可 diff、可审查（docs/architecture.md D6）。 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/content/main.js'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/content/index.js',
  target: ['chrome116'],           // 与 manifest.minimum_chrome_version 一致
  logLevel: 'info',
});
