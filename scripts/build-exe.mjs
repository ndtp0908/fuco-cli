// Dong goi pe thanh 1 file thuc thi duy nhat bang Node SEA (D6).
//   node scripts/build-exe.mjs           -> build cho he dieu hanh dang chay
//   node scripts/build-exe.mjs --win     -> tai node.exe Windows x64 roi dong goi pe.exe
// Can cai truoc: npm install (devDeps: esbuild, postject).
// Ket qua o thu muc dist-exe/ (da gitignore).
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-exe');
const NODE_VER = process.versions.node;
const win = process.argv.includes('--win');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} khi tai ${url}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', async () => {
        await fs.writeFile(dest, Buffer.concat(chunks));
        resolve();
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

const { build } = await import('esbuild');
const { inject } = await import('postject').catch(() => ({ inject: null }));

await fs.mkdir(OUT, { recursive: true });

// 1. Gom toan bo src -> 1 file CJS
const bundlePath = path.join(OUT, 'pe.cjs');
await build({
  entryPoints: [path.join(ROOT, 'src', 'pe.mjs')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: bundlePath,
  logLevel: 'info',
});

// 2. Tao SEA blob
const seaConfig = {
  main: bundlePath,
  output: path.join(OUT, 'sea.blob'),
  disableExperimentalSEAWarning: true,
};
const seaConfigPath = path.join(OUT, 'sea-config.json');
await fs.writeFile(seaConfigPath, JSON.stringify(seaConfig, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

// 3. Chuan bi binary node dich
let targetBin;
let outName;
if (win) {
  const zipName = `node-v${NODE_VER}-win-x64`;
  const nodeExe = path.join(OUT, 'node.exe');
  if (!(await fs.stat(nodeExe).catch(() => null))) {
    const url = `https://nodejs.org/dist/v${NODE_VER}/${zipName}.zip`;
    console.log(`Dang tai ${url} ...`);
    const zipPath = path.join(OUT, `${zipName}.zip`);
    await download(url, zipPath);
    run('python3', ['-c', `import zipfile; z=zipfile.ZipFile(r'${zipPath}'); z.extract('${zipName}/node.exe', r'${OUT}')`]);
    await fs.rename(path.join(OUT, zipName, 'node.exe'), nodeExe);
  }
  targetBin = nodeExe;
  outName = 'pe.exe';
} else {
  targetBin = process.execPath;
  outName = process.platform === 'win32' ? 'pe.exe' : 'pe';
}
const outPath = path.join(OUT, outName);
await fs.copyFile(targetBin, outPath);
try { await fs.chmod(outPath, 0o755); } catch { /* windows */ }

// 4. Tiem blob vao binary
const blob = await fs.readFile(seaConfig.output);
if (inject) {
  await inject(outPath, 'NODE_SEA_BLOB', blob, { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });
} else {
  run('npx', ['-y', 'postject', outPath, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']);
}
const st = await fs.stat(outPath);
console.log(`\nXong: ${outPath} (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
console.log('Chay thu: ' + outPath + ' --help');
