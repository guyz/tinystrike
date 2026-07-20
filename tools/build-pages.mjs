#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'dist', 'tinystrike');
const BUILD_MANIFEST = 'build-manifest.json';
const GENERATOR = 'tools/build-pages.mjs';

const THREE_FILES = [
  ['build/three.module.min.js', 'vendor/three/three.module.min.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'vendor/three/addons/loaders/GLTFLoader.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'vendor/three/addons/utils/BufferGeometryUtils.js'],
  ['examples/jsm/utils/SkeletonUtils.js', 'vendor/three/addons/utils/SkeletonUtils.js'],
  ['LICENSE', 'vendor/three/LICENSE.txt'],
];

function toPosix(value) {
  return value.split(path.sep).join('/');
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyFileWithParents(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyTree(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFileWithParents(sourcePath, destinationPath);
    } else {
      throw new Error(`Unsupported asset type: ${toPosix(path.relative(PROJECT_ROOT, sourcePath))}`);
    }
  }
}

export function moduleSpecifiers(source) {
  const result = new Set();
  const patterns = [
    /\b(?:import|export)\s+[^;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) result.add(match[1]);
  }
  return [...result].sort();
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function copyBrowserModuleGraph(outputDir) {
  const pending = [path.join(PROJECT_ROOT, 'src', 'main.js')];
  const copied = new Set();

  while (pending.length) {
    pending.sort((a, b) => b.localeCompare(a));
    const sourcePath = pending.pop();
    if (copied.has(sourcePath)) continue;
    if (!isWithin(PROJECT_ROOT, sourcePath)) {
      throw new Error(`Browser module escapes the project: ${sourcePath}`);
    }

    const source = await readFile(sourcePath, 'utf8');
    const relativePath = path.relative(PROJECT_ROOT, sourcePath);
    await copyFileWithParents(sourcePath, path.join(outputDir, relativePath));
    copied.add(sourcePath);

    for (const specifier of moduleSpecifiers(source)) {
      if (specifier === 'three' || specifier.startsWith('three/addons/')) continue;
      if (!specifier.startsWith('.')) {
        throw new Error(`Unsupported browser dependency "${specifier}" in ${toPosix(relativePath)}`);
      }
      const dependency = path.resolve(path.dirname(sourcePath), specifier);
      if (!(await exists(dependency)) || !(await stat(dependency)).isFile()) {
        throw new Error(`Missing browser dependency "${specifier}" in ${toPosix(relativePath)}`);
      }
      pending.push(dependency);
    }
  }

  return [...copied].map((file) => toPosix(path.relative(PROJECT_ROOT, file))).sort();
}

function normalizeHttpEndpoint(value, label) {
  if (!value) return '';
  if (value.startsWith('/') && !value.startsWith('//')) {
    return value === '/' ? value : value.replace(/\/+$/, '');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL or a root-relative path.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, a query, or a fragment.`);
  }
  return url.href.replace(/\/+$/, '');
}

function normalizeWebSocketEndpoint(value, label) {
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute WS(S) URL.`);
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} must be a WS(S) URL without credentials, a query, or a fragment.`);
  }
  return url.href.replace(/\/+$/, '');
}

function endpoints(options = {}) {
  const serviceValue = options.serviceUrl || '';
  let derivedLeaderboard = '';
  let derivedWebSocket = '';
  if (serviceValue) {
    const service = normalizeHttpEndpoint(serviceValue, 'Service URL');
    if (service.startsWith('/')) {
      throw new Error('Service URL must be absolute so a WebSocket endpoint can be derived.');
    }
    derivedLeaderboard = `${service}/api/leaderboard`;
    derivedWebSocket = `${service.replace(/^http/, 'ws')}/ws`;
  }

  const leaderboard = normalizeHttpEndpoint(
    options.leaderboardUrl || derivedLeaderboard,
    'Leaderboard URL',
  );
  const websocket = normalizeWebSocketEndpoint(
    options.websocketUrl || derivedWebSocket,
    'WebSocket URL',
  );
  return { leaderboard, websocket };
}

function runtimeConfigSource(config) {
  const configured = {};
  if (config.leaderboard) configured.leaderboard = config.leaderboard;
  if (config.websocket) configured.websocket = config.websocket;
  return [
    '// Generated by tools/build-pages.mjs. This file may be replaced at deploy time.',
    '(() => {',
    `  const deploymentConfig = ${JSON.stringify(configured, null, 2).replace(/\n/g, '\n  ')};`,
    '  globalThis.TINY_STRIKE_API = Object.freeze({',
    '    ...(globalThis.TINY_STRIKE_API || {}),',
    '    ...deploymentConfig,',
    '  });',
    '})();',
    '',
  ].join('\n');
}

function pagesIndex(source) {
  const coreSource = './node_modules/three/build/three.module.js';
  const addonsSource = './node_modules/three/examples/jsm/';
  const moduleTag = '  <script type="module" src="./src/main.js"></script>';
  for (const required of [coreSource, addonsSource, moduleTag]) {
    if (!source.includes(required)) throw new Error(`index.html is missing expected build marker: ${required}`);
  }
  return source
    .replace(coreSource, './vendor/three/three.module.min.js')
    .replace(addonsSource, './vendor/three/addons/')
    .replace(moduleTag, `  <script src="./runtime-config.js"></script>\n${moduleTag}`);
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const result = [];
  for (const entry of entries) {
    const filePath = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(root, filePath));
    else if (entry.isFile()) result.push(toPosix(path.relative(root, filePath)));
    else throw new Error(`Build contains unsupported entry: ${filePath}`);
  }
  return result;
}

async function sha256(filePath) {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

async function createManifest(outputDir, config, threeVersion) {
  const paths = (await walkFiles(outputDir)).filter((file) => file !== BUILD_MANIFEST);
  const files = [];
  for (const file of paths) {
    const filePath = path.join(outputDir, file);
    const info = await stat(filePath);
    files.push({ path: file, bytes: info.size, sha256: await sha256(filePath) });
  }
  const manifest = {
    formatVersion: 1,
    generator: GENERATOR,
    app: 'tiny-strike',
    threeVersion,
    endpoints: {
      leaderboard: config.leaderboard || null,
      websocket: config.websocket || null,
    },
    files,
  };
  await writeFile(path.join(outputDir, BUILD_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function assertSafeOutput(outputDir) {
  const resolved = path.resolve(outputDir);
  const filesystemRoot = path.parse(resolved).root;
  if ([filesystemRoot, PROJECT_ROOT, homedir()].includes(resolved)) {
    throw new Error(`Refusing to clean unsafe output directory: ${resolved}`);
  }
  if (!(await exists(resolved)) || resolved === DEFAULT_OUTPUT) return;
  const entries = await readdir(resolved);
  if (!entries.length) return;
  const manifestPath = path.join(resolved, BUILD_MANIFEST);
  if (!(await exists(manifestPath))) {
    throw new Error(`Refusing to replace non-build directory without ${BUILD_MANIFEST}: ${resolved}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Refusing to replace output with an invalid ${BUILD_MANIFEST}: ${resolved}`);
  }
  if (manifest.generator !== GENERATOR || manifest.app !== 'tiny-strike') {
    throw new Error(`Refusing to replace output owned by another generator: ${resolved}`);
  }
}

export async function verifyPagesBuild(outputDir) {
  const required = [
    '.nojekyll',
    'index.html',
    'runtime-config.js',
    'src/main.js',
    'vendor/three/three.module.min.js',
    'vendor/three/addons/loaders/GLTFLoader.js',
    'vendor/three/addons/utils/BufferGeometryUtils.js',
    'vendor/three/addons/utils/SkeletonUtils.js',
    'vendor/three/LICENSE.txt',
  ];
  for (const file of required) {
    if (!(await exists(path.join(outputDir, file)))) throw new Error(`Build is missing ${file}`);
  }

  const index = await readFile(path.join(outputDir, 'index.html'), 'utf8');
  if (index.includes('node_modules/')) throw new Error('Built index.html still references node_modules.');
  if (!index.includes('./runtime-config.js')) throw new Error('Built index.html does not load runtime-config.js.');
  if (!index.includes('./vendor/three/three.module.min.js')) throw new Error('Built index.html does not use vendored Three.js.');

  const files = await walkFiles(outputDir);
  if (files.some((file) => file.startsWith('src/server/') || file.includes('/node_modules/'))) {
    throw new Error('Build contains server-only or node_modules content.');
  }

  for (const file of files.filter((entry) => entry.endsWith('.js'))) {
    const source = await readFile(path.join(outputDir, file), 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier === 'three') continue;
      if (specifier.startsWith('three/addons/')) {
        const vendorPath = path.join(outputDir, 'vendor', 'three', 'addons', specifier.slice('three/addons/'.length));
        if (!(await exists(vendorPath))) throw new Error(`${file} has missing vendored dependency ${specifier}`);
        continue;
      }
      if (!specifier.startsWith('.')) throw new Error(`${file} has unsupported dependency ${specifier}`);
      const dependency = path.resolve(outputDir, path.dirname(file), specifier);
      if (!isWithin(outputDir, dependency) || !(await exists(dependency))) {
        throw new Error(`${file} has missing dependency ${specifier}`);
      }
    }
  }

  const sourceAssets = await walkFiles(path.join(PROJECT_ROOT, 'assets'));
  for (const asset of sourceAssets) {
    const builtAsset = path.join(outputDir, 'assets', asset);
    if (!(await exists(builtAsset))) throw new Error(`Build is missing asset ${asset}`);
    const [sourceHash, builtHash] = await Promise.all([
      sha256(path.join(PROJECT_ROOT, 'assets', asset)),
      sha256(builtAsset),
    ]);
    if (sourceHash !== builtHash) throw new Error(`Built asset differs from source: ${asset}`);
  }

  return { files: files.length, assets: sourceAssets.length };
}

export async function buildPages(options = {}) {
  const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT);
  const config = endpoints(options);
  await assertSafeOutput(outputDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const index = pagesIndex(await readFile(path.join(PROJECT_ROOT, 'index.html'), 'utf8'));
  await writeFile(path.join(outputDir, 'index.html'), index);
  await writeFile(path.join(outputDir, 'runtime-config.js'), runtimeConfigSource(config));
  await writeFile(path.join(outputDir, '.nojekyll'), '');
  const browserModules = await copyBrowserModuleGraph(outputDir);
  await copyTree(path.join(PROJECT_ROOT, 'assets'), path.join(outputDir, 'assets'));

  const threeRoot = path.join(PROJECT_ROOT, 'node_modules', 'three');
  for (const [source, destination] of THREE_FILES) {
    await copyFileWithParents(path.join(threeRoot, source), path.join(outputDir, destination));
  }
  const threePackage = JSON.parse(await readFile(path.join(threeRoot, 'package.json'), 'utf8'));
  const verification = await verifyPagesBuild(outputDir);
  const manifest = await createManifest(outputDir, config, threePackage.version);
  return { outputDir, browserModules, verification, manifest };
}

function usage() {
  return [
    'Build a self-contained Tiny Strike artifact for GitHub Pages.',
    '',
    'Usage: node tools/build-pages.mjs [options]',
    '',
    '  --out DIR                 Output directory (default: dist/tinystrike)',
    '  --service-url URL         Backend origin; derives /api/leaderboard and /ws',
    '  --leaderboard-url URL     Override the leaderboard API base URL',
    '  --websocket-url URL       Override the multiplayer WebSocket URL',
    '  --help                    Show this help',
    '',
    'Environment alternatives:',
    '  TINY_STRIKE_SERVICE_URL, TINY_STRIKE_LEADERBOARD_URL,',
    '  TINY_STRIKE_WEBSOCKET_URL',
    '',
  ].join('\n');
}

function parseArgs(argv, env = process.env) {
  const parsed = {
    outputDir: DEFAULT_OUTPUT,
    serviceUrl: env.TINY_STRIKE_SERVICE_URL || '',
    leaderboardUrl: env.TINY_STRIKE_LEADERBOARD_URL || '',
    websocketUrl: env.TINY_STRIKE_WEBSOCKET_URL || '',
  };
  const valueFlags = new Map([
    ['--out', 'outputDir'],
    ['--service-url', 'serviceUrl'],
    ['--leaderboard-url', 'leaderboardUrl'],
    ['--websocket-url', 'websocketUrl'],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const property = valueFlags.get(flag);
    if (!property) throw new Error(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    parsed[property] = value;
  }
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await buildPages(options);
  const endpointMode = result.manifest.endpoints.leaderboard ? 'remote service configured' : 'same-origin defaults';
  process.stdout.write(
    `Tiny Strike Pages build: ${result.outputDir}\n` +
    `${result.manifest.files.length} files, ${result.verification.assets} assets, ${endpointMode}.\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`Pages build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
