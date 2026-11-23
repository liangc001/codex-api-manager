const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPasswordCheck } = require('./access-check.cjs');

async function unlockApplication({ BrowserWindow, ipcMain, onWindow, record, memory }) {
  const check = createPasswordCheck(record || require('./access-config.cjs'));
  const file = path.join(__dirname, '..', 'public', 'unlock.html');
  const trustedPage = pathToFileURL(file).href;
  const win = new BrowserWindow({
    width: 440, height: 500, minWidth: 360, minHeight: 440, maximizable: false,
    title: 'API 切换台', show: false, autoHideMenuBar: true, backgroundColor: '#f4f6f5',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'access-preload.cjs'), partition: 'startup-access',
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  onWindow(win);
  win.removeMenu();
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== trustedPage) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  let accepted = false, resolve;
  const unlocked = new Promise(done => { resolve = done; });
  ipcMain.handle('access:unlock', async (event, password) => {
    if (win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== trustedPage) return { ok: false, error: '无法解锁此窗口。' };
    if (accepted) return { ok: true };
    try {
      const result = await check(password);
      if (result.ok && !win.isDestroyed()) {
        try { await memory?.remember(); }
        catch { return { ok: false, error: '无法保存登录状态，请检查本机目录权限后重试。', retryAfterMs: 1000 }; }
        if (!win.isDestroyed()) { accepted = true; resolve(true); }
      }
      return result;
    } catch { return { ok: false, error: '暂时无法验证密码，请重试。', retryAfterMs: 1000 }; }
  });
  win.once('closed', () => {
    ipcMain.removeHandler('access:unlock');
    if (!accepted) resolve(false);
  });
  win.once('ready-to-show', () => win.show());
  try { await win.loadFile(file); }
  catch (error) { win.destroy(); throw error; }
  return unlocked;
}

module.exports = { unlockApplication };
