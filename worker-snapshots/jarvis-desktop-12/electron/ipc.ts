// Registers one ipcMain handler per JarvisAPI method. All logic lives in ipcCore.ts.
import {ipcMain, type IpcMainInvokeEvent} from 'electron';
import {METHODS, channel} from './channels';
import {dispatch, type HandlerMap, type RouterOptions} from './ipcCore';

export function registerIpc(handlers: HandlerMap, opts: RouterOptions): () => void {
  for (const m of METHODS) {
    ipcMain.handle(channel(m), (event: IpcMainInvokeEvent, ...args: unknown[]) =>
      dispatch(handlers, m, args, event.senderFrame?.url, opts, event.senderFrame === event.sender.mainFrame));
  }
  return () => { for (const m of METHODS) ipcMain.removeHandler(channel(m)); };
}
