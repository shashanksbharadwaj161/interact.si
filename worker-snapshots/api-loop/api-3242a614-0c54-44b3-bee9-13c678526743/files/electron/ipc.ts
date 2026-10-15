// Registers one ipcMain handler per JarvisAPI method. All logic lives in ipcCore.ts.
import {BrowserWindow, app, ipcMain, powerMonitor, type IpcMainInvokeEvent, type WebContents} from 'electron';
import {HOST_BATTERY_EVENT, METHODS, MODEL_PIN_METHODS, channel, modelPinArgsProblem, modelPinChannel, type ModelPinMethod} from './channels';
import {dispatch, isTrustedUrl, safeErrorMessage, type HandlerMap, type RouterOptions} from './ipcCore';
import {HostBatteryReader, powerMonitorAdapter, type PowerMonitorLike} from './services/system';
import {ModelPinService, PIN_SIDECAR} from './services/models';
import {createJsonSidecar} from './services/sidecar';

/**
 * Production pin service: the existing JSON sidecar store under userData, and the installed list (with digests) from the
 * existing guarded local Ollama runtime via modelsOverview. No new network target.
 */
function defaultModelPins(handlers: HandlerMap): ModelPinService {
  return new ModelPinService({
    storage: createJsonSidecar(app.getPath('userData'), PIN_SIDECAR),
    list: async () => {
      const o = await handlers.modelsOverview();
      return o.installedError ? {ok: false, reason: o.installedError} : {ok: true, models: o.installed};
    },
  });
}

export function registerIpc(handlers: HandlerMap, opts: RouterOptions, hostBattery: HostBatteryReader = new HostBatteryReader(powerMonitorAdapter(powerMonitor as unknown as PowerMonitorLike)), modelPins?: ModelPinService): () => void {
  for (const m of METHODS) {
    ipcMain.handle(channel(m), (event: IpcMainInvokeEvent, ...args: unknown[]) =>
      dispatch(handlers, m, args, event.senderFrame?.url, opts, event.senderFrame === event.sender.mainFrame));
  }
  // Model pinning (goals 17-19): same sender trust rule as dispatch (trusted app page, main frame only), then the
  // argument shape check, then the service's own name validation. Errors are redacted like every other method.
  let pins: ModelPinService | null = modelPins ?? null;
  const pinService = (): ModelPinService => {
    if (!pins) pins = defaultModelPins(handlers);
    return pins;
  };
  const pinHandlers: Record<ModelPinMethod, (...a: unknown[]) => Promise<unknown>> = {
    modelsPin: (name) => pinService().pin(name),
    modelsUnpin: (name) => pinService().unpin(name),
    modelsPins: () => pinService().all(),
  };
  for (const m of MODEL_PIN_METHODS) {
    ipcMain.handle(modelPinChannel(m), async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.senderFrame !== event.sender.mainFrame || !isTrustedUrl(event.senderFrame?.url, opts.appFileUrl, opts.devOrigin)) throw new Error('Request rejected: untrusted sender');
      const problem = modelPinArgsProblem(m, args);
      if (problem) throw new Error(problem);
      try { return await pinHandlers[m](...args); } catch (e) { throw new Error(safeErrorMessage(e)); }
    });
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
    for (const m of MODEL_PIN_METHODS) ipcMain.removeHandler(modelPinChannel(m));
    try { app.removeListener('browser-window-created', onWindow); } catch { /* already gone */ }
    stopBattery();
  };
}
