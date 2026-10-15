// Registers one ipcMain handler per JarvisAPI method. All logic lives in ipcCore.ts.
import {BrowserWindow, app, ipcMain, powerMonitor, type IpcMainInvokeEvent, type WebContents} from 'electron';
import {HOST_BATTERY_EVENT, METHODS, MODEL_PIN_ARITY, MODEL_PIN_METHODS, channel, type ModelPinMethod} from './channels';
import {dispatch, isTrustedUrl, safeErrorMessage, type HandlerMap, type RouterOptions} from './ipcCore';
import {HostBatteryReader, powerMonitorAdapter, type PowerMonitorLike} from './services/system';
import {ModelPinService, createFilePinStorage, defaultModelRoots, validateModelName} from './services/models';

/** Production pin service: model-pins.json in userData; hashes only known model files. Null when userData is unavailable. */
export function createDefaultPinService(): ModelPinService | null {
  try {
    const userData = app.getPath('userData');
    return new ModelPinService({storage: createFilePinStorage(userData), modelRoots: () => defaultModelRoots(process.env, userData)});
  } catch { return null; }
}

const PIN_LABEL_MAX = 80;

/** Inline input checks for the pin channels, in the same style as ARG_SPECS: type, presence and size first. */
export function pinArgProblem(method: ModelPinMethod, args: readonly unknown[]): string | null {
  if (!Array.isArray(args) || args.length > MODEL_PIN_ARITY[method]) return 'Wrong number of arguments';
  const modelId = (v: unknown, optional = false): string | null => {
    if (v === undefined) return optional ? null : 'Wrong number of arguments';
    if (typeof v !== 'string' || !v || v.length > 200) return `Invalid argument 1 for ${method}: expected a model name`;
    try { validateModelName(v); } catch (e) { return `Invalid argument 1 for ${method}: ${(e as Error).message}`; }
    return null;
  };
  switch (method) {
    case 'modelPinsList': return null;
    case 'modelPinsCancelVerify': return modelId(args[0], true);
    case 'modelPinsPinCurrent': {
      const bad = modelId(args[0]);
      if (bad) return bad;
      const label = args[1];
      if (label !== undefined && (typeof label !== 'string' || label.length > PIN_LABEL_MAX)) return `Invalid argument 2 for ${method}: label must be text up to ${PIN_LABEL_MAX} characters`;
      return null;
    }
    default: return modelId(args[0]);
  }
}

async function dispatchPin(pins: ModelPinService, m: ModelPinMethod, args: unknown[], senderUrl: string | undefined, opts: RouterOptions, isMainFrame: boolean): Promise<unknown> {
  if (!isMainFrame || !isTrustedUrl(senderUrl, opts.appFileUrl, opts.devOrigin)) throw new Error('Request rejected: untrusted sender');
  const invalid = pinArgProblem(m, args);
  if (invalid) throw new Error(invalid);
  try {
    switch (m) {
      case 'modelPinsList': return await pins.list();
      case 'modelPinsPinCurrent': return await pins.pinCurrent(args[0], args[1]);
      case 'modelPinsUnpin': return await pins.unpin(args[0]);
      case 'modelPinsVerify': return await pins.verify(args[0]);
      case 'modelPinsCancelVerify': return pins.cancelVerify(args[0]);
      case 'modelPinsAcknowledgeRepin': return await pins.acknowledgeRepin(args[0]);
    }
  } catch (e) {
    throw new Error(safeErrorMessage(e));
  }
  throw new Error('Unknown method');
}

/** A pinned model whose file no longer matches is not activated: modelsSelect returns the blocked result instead. */
function withPinGate(handlers: HandlerMap, pins: ModelPinService | null): HandlerMap {
  if (!pins) return handlers;
  const select = handlers.modelsSelect;
  return {
    ...handlers,
    modelsSelect: async (name, selectOpts) => {
      const blocked = await pins.gate(name);
      if (blocked) return blocked;
      return selectOpts === undefined ? select(name) : select(name, selectOpts);
    },
  };
}

/**
 * `pins` is opt-in: with null (the default) nothing extra is registered and modelsSelect is unchanged, so the handler table
 * stays exactly one handler per METHODS entry. The composition root enables version pins by passing createDefaultPinService().
 */
export function registerIpc(handlers: HandlerMap, opts: RouterOptions, hostBattery: HostBatteryReader = new HostBatteryReader(powerMonitorAdapter(powerMonitor as unknown as PowerMonitorLike)), pins: ModelPinService | null = null): () => void {
  const routed = withPinGate(handlers, pins);
  for (const m of METHODS) {
    ipcMain.handle(channel(m), (event: IpcMainInvokeEvent, ...args: unknown[]) =>
      dispatch(routed, m, args, event.senderFrame?.url, opts, event.senderFrame === event.sender.mainFrame));
  }
  // Model version pins: same `jarvis:` prefix and trusted-sender guard, inline argument checks above.
  if (pins) {
    for (const m of MODEL_PIN_METHODS) {
      ipcMain.handle(channel(m), (event: IpcMainInvokeEvent, ...args: unknown[]) =>
        dispatchPin(pins, m, args, event.senderFrame?.url, opts, event.senderFrame === event.sender.mainFrame));
    }
  }
  // Read-only host power state (on battery / on AC). It is pushed, never requested: the renderer cannot send anything
  // for it, so no handler, argument or permission is added. Only pages that pass the same isTrustedUrl check as dispatch
  // receive it. The reader never throws and reports 'unmeasured' when it cannot tell; it has no percentage.
  const pushTo = (wc: WebContents, status = hostBattery.read()) => {
    try {
      if (!wc.isDestroyed() && isTrustedUrl(wc.getURL(), opts.appFileUrl, opts.devOrigin)) wc.send(HOST_BATTERY_EVENT, status);
    } catch { /* a closing window must not break the others */ }
  };
  const onWindow = (_e: unknown, win: BrowserWindow) => {
    try { win.webContents.on('did-finish-load', () => pushTo(win.webContents)); } catch { /* window already gone */ }
  };
  try { app.on('browser-window-created', onWindow); } catch { /* host without window events: changes are still pushed */ }
  const stopBattery = hostBattery.subscribe((status) => {
    try { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) pushTo(w.webContents, status); } catch { /* no windows */ }
  });
  return () => {
    for (const m of METHODS) ipcMain.removeHandler(channel(m));
    if (pins) {
      pins.cancelVerify();
      for (const m of MODEL_PIN_METHODS) ipcMain.removeHandler(channel(m));
    }
    try { app.removeListener('browser-window-created', onWindow); } catch { /* already gone */ }
    stopBattery();
  };
}
