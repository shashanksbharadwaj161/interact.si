// Registers one ipcMain handler per JarvisAPI method. All logic lives in ipcCore.ts.
import {BrowserWindow, app, ipcMain, powerMonitor, type IpcMainInvokeEvent, type WebContents} from 'electron';
import {HOST_BATTERY_EVENT, METHODS, channel} from './channels';
import {dispatch, isTrustedUrl, safeErrorMessage, type HandlerMap, type RouterOptions} from './ipcCore';
import {HostBatteryReader, powerMonitorAdapter, type PowerMonitorLike} from './services/system';

export function registerIpc(handlers: HandlerMap, opts: RouterOptions, hostBattery: HostBatteryReader = new HostBatteryReader(powerMonitorAdapter(powerMonitor as unknown as PowerMonitorLike))): () => void {
  for (const m of METHODS) {
    ipcMain.handle(channel(m), (event: IpcMainInvokeEvent, ...args: unknown[]) =>
      dispatch(handlers, m, args, event.senderFrame?.url, opts, event.senderFrame === event.sender.mainFrame));
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
    try { app.removeListener('browser-window-created', onWindow); } catch { /* already gone */ }
    stopBattery();
  };
}
