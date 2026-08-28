import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The Python runtime is downloaded lazily on first AutoEdit entry — see
// autoedit_python.rs — so no prep step is needed here.

const platform = os.platform(); // 'darwin', 'win32', 'linux'
const arch = os.arch(); // 'arm64', 'x64'

let feature = '';
let targetTriple = '';

if (platform === 'darwin') {
  if (arch === 'arm64') {
    feature = 'mac-aarch';
    targetTriple = 'aarch64-apple-darwin';
  } else {
    feature = 'mac-x86_64';
    targetTriple = 'x86_64-apple-darwin';
  }
} else if (platform === 'win32') {
  feature = 'windows';
  targetTriple = 'x86_64-pc-windows-msvc';
} else if (platform === 'linux') {
  feature = 'linux';
  targetTriple = 'x86_64-unknown-linux-gnu';
} else {
  console.error(`[AutoSubs Dev] Unsupported platform: ${platform}`);
  process.exit(1);
}

// Ensure ffmpeg binary exists for macOS externalBin requirement
if (platform === 'darwin') {
  const binariesDir = path.resolve(__dirname, '../src-tauri/binaries');
  const ffmpegTarget = path.join(binariesDir, `ffmpeg-${targetTriple}`);

  if (!fs.existsSync(ffmpegTarget)) {
    fs.mkdirSync(binariesDir, { recursive: true });
    try {
      const systemFfmpeg = execSync('which ffmpeg', { encoding: 'utf-8' }).trim();
      if (systemFfmpeg && fs.existsSync(systemFfmpeg)) {
        fs.symlinkSync(systemFfmpeg, ffmpegTarget);
        console.log(`[AutoSubs Dev] Linked ffmpeg from ${systemFfmpeg} -> ${ffmpegTarget}`);
      }
    } catch {
      console.warn(`[AutoSubs Dev] Warning: ffmpeg not found in PATH. Make sure ffmpeg is installed.`);
    }
  }
}

const args = ['tauri', 'dev', '--features', feature, '--', '--no-default-features'];

console.log(`[AutoSubs Dev] Platform: ${platform} (${arch})`);
console.log(`[AutoSubs Dev] Command: npx ${args.join(' ')}`);

const child = spawn('npx', args, { stdio: 'inherit' });

child.on('close', (code) => {
  process.exit(code || 0);
});

