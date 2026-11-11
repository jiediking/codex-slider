import {SliderError, validatePresets, presetErrors, VERSION} from './core.mjs';
import {discoverModels} from './rpc.mjs';

export class Controller {
  constructor(store, bridge, {loadModels = discoverModels, fixtureCatalog = null, testMode = false} = {}) {
    this.store = store;
    this.bridge = bridge;
    this.loadModels = loadModels;
    this.fixtureCatalog = fixtureCatalog;
    this.testMode = testMode;
    this.app = {found: false, compatible: false};
    this.account = 'loading';
    this.running = false;
    this.busy = false;
    this.phase = 'Checking Codex';
    this.error = null;
    this.lastLaunch = null;
  }

  snapshot() {
    const session=this.bridge.session;
    const consumerVerified=this.running&&this.lastLaunch?.consumerVerified===true&&session?.result===this.lastLaunch&&
      ['appPath','version','build','rendererSha256'].every(key=>session.app[key]===this.app[key]);
    return {...this.store.snapshot(), version: VERSION, testMode: this.testMode,
      app: {found: this.app.found, compatible: this.app.compatible, version: this.app.version ?? null,
        build: this.app.build ?? null, running: this.running, upgradeRequired: this.app.upgradeRequired === true,
        compatibilityReason:this.app.compatibilityReason ?? null, appPath:this.app.appPath ?? null,
        requiresRuntimeCheck:this.app.requiresRuntimeCheck === true,automaticStatus:this.app.automaticStatus ?? null,
        configurationApplied:this.app.configurationApplied === true,consumerVerified,
        consumerPreviouslyVerified:this.app.consumerPreviouslyVerified===true,
        installationCount:this.app.installations?.length ?? (this.app.found ? 1 : 0)},
      account: this.account, busy: this.busy, phase: this.phase, error: this.error,
      compatibility:this.app.compatibility ?? null,
      lastLaunch: this.lastLaunch};
  }

  async task(action) {
    if (this.busy) throw new SliderError('BUSY', 'Another operation is in progress. Please wait.', 409);
    this.busy = true;
    try { return await action(); }
    finally {
      this.busy = false; this.phase = '';
      if (this.compatibilityPending) {
        const refreshRemote=this.compatibilityForcePending===true;
        this.compatibilityPending = false;this.compatibilityForcePending=false;
        queueMicrotask(() => this.refreshCompatibility({refreshRemote}).catch(() => {}));
      }
    }
  }

  async refreshCompatibility({refreshRemote=false} = {}) {
    if (this.busy) {this.compatibilityPending = true;this.compatibilityForcePending ||= refreshRemote;return;}
    await this.task(async () => {
      this.phase = 'Checking compatibility';
      this.app = await this.bridge.inspect({refreshCompatibility:refreshRemote,forceCompatibility:refreshRemote});
      this.running = this.app.found && (await this.bridge.running(this.app)).length > 0;
    });
  }

  async checkCompatibility() {
    if (this.busy) throw new SliderError('BUSY', 'Please wait for the current operation to finish.', 409);
    await this.refreshCompatibility({refreshRemote:true});
    if(['verification-pending','adapter-incompatible'].includes(this.lastLaunch?.status))await this.verifySlider({retry:true});
    return this.snapshot();
  }

  async verifySlider({retry=false}={}) {
    let result=this.lastLaunch;
    if(result?.status==='verification-pending'||retry&&result?.status==='adapter-incompatible')await this.task(async()=>{
      this.phase='Checking the rendered slider';
      result=await this.bridge.verifySession({retry});this.lastLaunch=result;
      if(result.status==='consumer-verified'||result.status==='adapter-incompatible')this.app=await this.bridge.inspect();
    });
    return {result,state:this.snapshot()};
  }

  async readEnvironment(refreshCompatibility = false, forceCompatibility = false) {
    this.phase = 'Checking Codex';
    this.app = await this.bridge.inspect({refreshCompatibility,forceCompatibility});
    this.running = this.app.found && (await this.bridge.running(this.app)).length > 0;
    if (!this.app.found) {
      this.account = 'unavailable';
      throw new SliderError('APP_MISSING', 'Install the official Codex desktop app, then check again.');
    }
    this.phase = 'Reading your models';
    if (!this.fixtureCatalog && !this.app.cli) throw new SliderError('CLI_MISSING', 'The Codex model reader was not found in this installation.');
    const catalog = this.fixtureCatalog ?? await this.loadModels(this.app.cli);
    this.store.setCatalog(catalog);
    this.account = 'ready';
    this.error = null;
  }

  async refresh({forceCompatibility=false} = {}) {
    await this.task(async () => {
      try { await this.readEnvironment(true,forceCompatibility); }
      catch (error) {
        this.account = error.code === 'SIGN_IN_REQUIRED' ? 'signed-out' : 'error';
        this.error = error instanceof SliderError ? error.message : 'Codex could not be checked. Try checking again.';
      }
    });
    return this.snapshot();
  }

  save({presets, revision}) {
    if (this.busy) throw new SliderError('BUSY', 'Please wait for the current operation to finish.', 409);
    if (this.account !== 'ready') throw new SliderError('MODELS_NOT_READY', 'Refresh your models before saving.', 409);
    this.store.save(presets, revision);
    return this.snapshot();
  }

  async launch({presets, revision, allowLocalDebug = false, standard = false}) {
    if (typeof allowLocalDebug !== 'boolean' || typeof standard !== 'boolean') {
      throw new SliderError('BAD_REQUEST', 'Launch options must be true or false.');
    }
    let result;
    await this.task(async () => {
      this.store.assertRevision(revision);
      this.lastLaunch = null;
      if (standard) {
        if (this.account === 'ready' && presetErrors(presets, this.store.catalog).length === 0) {
          this.store.save(presets, revision);
        }
        result = await this.bridge.launch({app: this.app, directory: this.store.directory, standard: true,
          onPhase: phase => { this.phase = phase; }});
      } else {
        try { await this.readEnvironment(true); }
        catch (error) {
          this.account = error.code === 'SIGN_IN_REQUIRED' ? 'signed-out' : 'error';
          this.error = error instanceof SliderError ? error.message : 'Your models could not be checked. Try again.';
          throw error;
        }
        if (!this.app.compatible) throw new SliderError('VERSION_UNSUPPORTED', 'This Codex build is not supported. Your presets are kept in the editor.', 409);
        const cleaned = validatePresets(presets, this.store.catalog);
        const consent = this.store.consent || allowLocalDebug === true;
        if (!consent) throw new SliderError('CONSENT_REQUIRED', 'Enable the local debugging connection to apply your custom slider.', 409);
        this.store.save(cleaned, this.store.revision, consent);
        try {
          result = await this.bridge.launch({app: this.app, presets: cleaned, directory: this.store.directory,
            consent, onPhase: phase => { this.phase = phase; }});
          if (result.status === 'verification-pending') this.app = await this.bridge.inspect();
        } catch (error) {
          if (error.code === 'ADAPTER_INCOMPATIBLE') this.app = await this.bridge.inspect();
          throw error;
        }
      }
      this.running = ['applied','verification-pending', 'standard-opened', 'already-running', 'needs-quit'].includes(result.status);
      this.lastLaunch = result;
    });
    return {result, state: this.snapshot()};
  }
}
