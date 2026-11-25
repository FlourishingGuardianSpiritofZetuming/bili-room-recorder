// 重新构建 extension/vendor 里的第三方产物：
//   extension/vendor/asr-bundle.js + extension/vendor/prebuilt/asr.wasm  （@sherpaw/asr）
//   extension/vendor/fix-webm-duration.js                               （fix-webm-duration）
//   extension/vendor/brotli_dec_wasm*.js/.wasm                          （brotli-dec-wasm）
//
// 用法：node scripts/build-vendor.mjs
// 需要：Node 18+、可访问 npm registry
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.vendor-build');
const VENDOR = join(ROOT, 'extension', 'vendor');

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'vendor-build', private: true, type: 'module' }, null, 2));
writeFileSync(
  join(TMP, 'entry.js'),
  `import { initASRModule, OfflineRecognizer } from '@sherpaw/asr';
import { loadVirtualData } from '@sherpaw/preloader';
export { initASRModule, OfflineRecognizer, loadVirtualData };
`,
);

console.log('== 安装依赖 ==');
run('npm', ['install', '--no-audit', '--no-fund', 'esbuild@0.25.0', '@sherpaw/asr@0.3.0', '@sherpaw/preloader@0.3.0', 'fix-webm-duration@1.0.6', 'brotli-dec-wasm@2.3.2'], TMP);

console.log('== 打包 sherpaw ASR ==');
run('npx', ['esbuild', 'entry.js', '--bundle', '--format=esm', '--platform=browser', '--external:module', '--external:fs', '--external:path', '--outfile=asr-bundle.js'], TMP);

mkdirSync(join(VENDOR, 'prebuilt'), { recursive: true });
cpSync(join(TMP, 'asr-bundle.js'), join(VENDOR, 'asr-bundle.js'));
cpSync(join(TMP, 'node_modules', '@sherpaw', 'asr', 'dist', 'prebuilt', 'asr.wasm'), join(VENDOR, 'prebuilt', 'asr.wasm'));

console.log('== 复制其它第三方文件 ==');
cpSync(join(TMP, 'node_modules', 'fix-webm-duration', 'fix-webm-duration.js'), join(VENDOR, 'fix-webm-duration.js'));
cpSync(join(TMP, 'node_modules', 'brotli-dec-wasm', 'pkg', 'brotli_dec_wasm.js'), join(VENDOR, 'brotli_dec_wasm.js'));
cpSync(join(TMP, 'node_modules', 'brotli-dec-wasm', 'pkg', 'brotli_dec_wasm_bg.wasm'), join(VENDOR, 'brotli_dec_wasm_bg.wasm'));

// 记录版本，便于追溯
const pkg = JSON.parse(readFileSync(join(TMP, 'package.json'), 'utf8'));
writeFileSync(join(VENDOR, 'VERSIONS.json'), JSON.stringify({ generatedAt: new Date().toISOString(), dependencies: pkg.dependencies || {} }, null, 2) + '\n');

rmSync(TMP, { recursive: true, force: true });
console.log('== 完成：extension/vendor 已更新 ==');
