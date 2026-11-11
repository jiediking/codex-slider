import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const VERSION = '0.6.6';
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const CATALOG_FORMAT = 'codex-model-presets-catalog/v1';
// The reviewed native slider excludes persistent and unknown reasoning efforts.
const sliderEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export class SliderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function text(value, limit = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= limit
    ? value.trim() : null;
}

export function normalizeCatalog(raw, kind = 'app-server') {
  const normalized = raw?.format === CATALOG_FORMAT;
  const data = raw?.result ?? raw;
  const rows = data?.data ?? data?.models;
  if (!data || raw.error || data.nextCursor != null || !Array.isArray(rows) || rows.length > 512) {
    throw new SliderError('CATALOG_INVALID', 'The model catalog is incomplete or invalid. Refresh models to try again.');
  }
  const seen = new Set();
  const models = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new SliderError('CATALOG_INVALID', 'Invalid model entry.');
    if (entry.hidden === true || entry.visibility === 'hide') continue;
    const id = text(entry.model ?? entry.slug ?? entry.id);
    if (!id || seen.has(id)) throw new SliderError('CATALOG_INVALID', 'The model catalog contains missing or duplicate model IDs.');
    seen.add(id);
    const levels = entry.supportedReasoningEfforts ?? entry.supported_reasoning_levels ?? (normalized ? entry.efforts : null);
    if (!Array.isArray(levels)) continue;
    const efforts = [];
    for (const level of levels) {
      const effort = text(level?.reasoningEffort ?? level?.effort ?? (normalized ? level?.id : null), 80);
      if (!effort) throw new SliderError('CATALOG_INVALID', 'A reasoning effort is missing its ID.');
      if (!sliderEfforts.has(effort)) continue;
      if (!efforts.some(value => value.id === effort)) efforts.push({id: effort, description: text(level.description, 800) ?? ''});
    }
    if (!efforts.length) continue;
    const requestedDefault = entry.defaultReasoningEffort ?? entry.default_reasoning_level ?? entry.defaultEffort;
    models.push({id, name: text(entry.displayName ?? entry.display_name ?? entry.name, 160) ?? id,
      efforts, defaultEffort: efforts.some(value => value.id === requestedDefault) ? requestedDefault : efforts[0].id,
      isDefault: entry.isDefault === true});
  }
  if (!models.length) throw new SliderError('CATALOG_EMPTY', 'No models with supported reasoning efforts were returned.');
  return {format: CATALOG_FORMAT, source: {kind, fetchedAt: new Date().toISOString()}, models};
}

export function makeDefaults(catalog) {
  const ordered = [...(catalog?.models ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const pairs = ordered.map(model => ({model: model.id, reasoning_effort: model.defaultEffort}));
  for (const model of ordered) {
    for (const effort of model.efforts) {
      if (effort.id !== model.defaultEffort) pairs.push({model: model.id, reasoning_effort: effort.id});
    }
  }
  return pairs.slice(0, 4);
}

export function presetErrors(presets, catalog) {
  if (!Array.isArray(presets)) return ['Presets must be a list.'];
  const errors = [];
  if (presets.length < 3 || presets.length > 7) errors.push('Keep between 3 and 7 presets.');
  const seen = new Set();
  for (const [index, preset] of presets.entries()) {
    const prefix = `Preset ${index + 1}: `;
    const modelID = text(preset?.model);
    const effortID = text(preset?.reasoning_effort, 80);
    const model = catalog?.models.find(value => value.id === modelID);
    if (!modelID || !effortID) errors.push(prefix + 'choose a model and reasoning effort.');
    else if (!model) errors.push(prefix + 'this model is no longer available. Choose another model.');
    else if (!model.efforts.some(value => value.id === effortID)) errors.push(prefix + 'choose a supported reasoning effort.');
    const key = JSON.stringify([modelID, effortID]);
    if (seen.has(key)) errors.push(prefix + 'each model and effort pair must be unique.');
    seen.add(key);
  }
  return errors;
}

export function validatePresets(presets, catalog) {
  const errors = presetErrors(presets, catalog);
  if (errors.length) throw new SliderError('PRESETS_INVALID', errors.join(' '));
  return presets.map(preset => ({model: preset.model.trim(), reasoning_effort: preset.reasoning_effort.trim()}));
}

export function readJSON(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw new Error('Invalid settings file.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function atomicJSON(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const temporary = path.join(directory, `.writing-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function digest(file) {
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Settings cannot be a symbolic link.');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function defaultDataDirectory() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Codex Slider');
}

export function validateDataDirectory(directory) {
  const resolved = path.resolve(directory);
  const existing = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.join(fs.realpathSync(nearestParent(resolved)), path.relative(nearestParent(resolved), resolved));
  const configuredHome = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const codexHome = fs.existsSync(configuredHome) ? fs.realpathSync(configuredHome) : configuredHome;
  if (existing.split(path.sep).some(part => part.endsWith('.app')) ||
      [codexHome, '/Applications', '/System', '/Library'].some(root => existing === root || existing.startsWith(root + path.sep))) {
    throw new SliderError('DATA_PATH_INVALID', 'Choose a separate folder for Codex Slider settings.');
  }
  return resolved;
}

function nearestParent(directory) {
  let parent = directory;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  return parent;
}

export class Store {
  constructor(directory) {
    this.directory = validateDataDirectory(directory);
    this.file = path.join(this.directory, 'settings.json');
    this.presets = [];
    this.catalog = null;
    this.saved = false;
    this.consent = false;
    this.storageError = null;
    this.diskHash = null;
    try {
      this.diskHash = digest(this.file);
      if (this.diskHash !== null) {
        const saved = readJSON(this.file);
        if (saved?.schemaVersion !== 1 || !Array.isArray(saved.presets)) throw new Error('Invalid format.');
        this.presets = saved.presets.map(preset => ({model: text(preset?.model) ?? '', reasoning_effort: text(preset?.reasoning_effort, 80) ?? ''}));
        this.saved = true;
        this.consent = saved.localDebugConsent === true;
      }
    } catch {
      this.storageError = 'Your settings could not be read. Back up settings.json from the settings folder, then move it aside and reopen this tool.';
    }
  }

  get revision() {
    return crypto.createHash('sha256').update(JSON.stringify({presets: this.presets, consent: this.consent,
      catalog: this.catalog, diskHash: this.diskHash})).digest('hex');
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    if (!this.saved && this.presets.length === 0) this.presets = makeDefaults(catalog);
  }

  assertRevision(revision) {
    if (this.storageError) throw new SliderError('SETTINGS_DAMAGED', this.storageError, 409);
    if (typeof revision !== 'string' || revision !== this.revision) throw new SliderError('SETTINGS_CHANGED', 'Settings changed in another window. Reload this page before saving.', 409);
    try {
      if (digest(this.file) !== this.diskHash) throw new Error('Changed.');
    } catch {
      throw new SliderError('SETTINGS_CHANGED', 'The settings file changed outside this tool. Reopen the tool before saving.', 409);
    }
  }

  save(presets, revision, consent = this.consent) {
    this.assertRevision(revision);
    const cleaned = validatePresets(presets, this.catalog);
    atomicJSON(this.file, {schemaVersion: 1, presets: cleaned, localDebugConsent: consent === true});
    this.presets = cleaned;
    this.consent = consent === true;
    this.saved = true;
    this.diskHash = digest(this.file);
  }

  snapshot() {
    return {presets: this.presets, catalog: this.catalog, saved: this.saved, consent: this.consent,
      revision: this.revision, storageError: this.storageError,
      validationErrors: this.catalog ? presetErrors(this.presets, this.catalog) : []};
  }
}
