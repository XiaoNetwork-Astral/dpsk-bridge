import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Host presets (name, default skills directory, manifest file name) are defined once in ./host-presets.json and shared with install.ps1.
const presetFile = fileURLToPath(new URL('./host-presets.json', import.meta.url));
const installScript = fileURLToPath(new URL('./install.ps1', import.meta.url));
const presets = JSON.parse(fs.readFileSync(presetFile, 'utf8'));
const presetNames = Object.keys(presets);
const fallbackPreset = presetNames.find(name => !presets[name].skills);
const state = path.join(os.homedir(), '.dpsk-bridge');
if (process.platform !== 'win32') {
  console.warn('WARNING: skills not synchronized (automatic skill synchronization requires Windows). Copy skill/ into your host skill directory.');
} else if (fs.existsSync(state)) {
  for (const file of fs.readdirSync(state).filter(name => /^installed-skills(?:-[A-Za-z0-9-]+)?\.host\.json$/.test(name))) {
    const host = JSON.parse(fs.readFileSync(path.join(state, file), 'utf8'));
    if (typeof host.root !== 'string' || !path.isAbsolute(host.root)) throw new Error(`Invalid host record: ${file}`);
    const requested = typeof host.target === 'string' ? host.target.toLowerCase() : '';
    const known = presetNames.find(name => name.toLowerCase() === requested);
    const target = known ?? fallbackPreset;
    if (!target) throw new Error(`No fallback host preset is defined for ${file} (target ${JSON.stringify(host.target)})`);
    if (!known) console.log(`Synchronizing ${file}: unknown preset ${JSON.stringify(host.target)} is handled as ${fallbackPreset} at ${host.root}.`);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installScript, '-SyncOnly', '-Target', target,
      ...(presets[target].skills ? [] : ['-SkillsDir', host.root])];
    const result = spawnSync('powershell.exe', args, { windowsHide: true, stdio: 'inherit', timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error(`Cannot synchronize ${target} skills: ${result.error?.message || result.status}`);
  }
}
