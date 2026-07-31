// pi-ux — shared configuration resolver
//
// Resolution order for default mode:
//   1. PI_UX_DEFAULT_MODE environment variable
//   2. Config file defaultMode field (XDG_CONFIG_HOME/pi-ux/config.json)
//   3. 'strict'

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_MODE = 'strict';
const RUNTIME_MODES = ['off', 'lite', 'strict'];

function normalizeMode(mode) {
  if (typeof mode !== 'string') return null;
  const normalized = mode.trim().toLowerCase();
  return RUNTIME_MODES.includes(normalized) ? normalized : null;
}

function normalizePersistedMode(mode) {
  return normalizeMode(mode);
}

function isDeactivationCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?\s]+$/, '');
  return t === 'stop ux' || t === 'normal mode';
}

function getConfigDir() {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'pi-ux');
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'pi-ux'
    );
  }
  return path.join(os.homedir(), '.config', 'pi-ux');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf8').replace(/^\uFEFF/, '');
    const config = JSON.parse(raw);
    if (config && typeof config === 'object') return config;
  } catch (_) {}
  return {};
}

function readConfigBool(envVar, configKey) {
  const env = process.env[envVar];
  if (env !== undefined) {
    const v = env.trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
  }
  return readConfig()[configKey] === true;
}

function getDefaultMode() {
  const envMode = process.env.PI_UX_DEFAULT_MODE;
  if (envMode && RUNTIME_MODES.includes(envMode.toLowerCase())) {
    return envMode.toLowerCase();
  }
  const config = readConfig();
  if (config.defaultMode && RUNTIME_MODES.includes(config.defaultMode.toLowerCase())) {
    return config.defaultMode.toLowerCase();
  }
  return DEFAULT_MODE;
}

function getQuietStartup() {
  return readConfigBool('PI_UX_QUIET_STARTUP', 'quietStartup');
}

function getHideStatus() {
  return readConfigBool('PI_UX_HIDE_STATUS', 'hideStatus');
}

function writeDefaultMode(mode) {
  const normalized = normalizeMode(mode);
  if (!normalized) return null;

  const config = readConfig();
  config.defaultMode = normalized;

  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return normalized;
}

module.exports = {
  DEFAULT_MODE,
  RUNTIME_MODES,
  getDefaultMode,
  getQuietStartup,
  getHideStatus,
  normalizeMode,
  normalizePersistedMode,
  isDeactivationCommand,
  writeDefaultMode,
};
