const { app, BrowserWindow, ipcMain, dialog, session, shell, Tray, Menu } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const codexRestarter = require('./restart-codex.cjs');

let window;
let manager;
let controller;
let storage;
let transfer;
let finishingQuit = false;
let quitRequested = false;
let restartingCodex = false;
let updater;
let updateRequested = false;
let tray;
let closePrompt = false, confirmedWindowExit = false;
let restartAfterShutdown = false;
async function restartForDirectConnection() {
  const target = await codexRestarter.probe();
  if (target.running) await codexRestarter.restart(target);
  await storage.record('operation', { operation: 'restart-codex', outcome: 'ok' });
}
function showWindow() { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function trayAction(action, id) {
  showWindow();
  if (!quitRequested && window && !window.webContents.isDestroyed()) window.webContents.send('manager:tray-action', { action, id });
}
function renderTray(state) {
  if (!tray || tray.isDestroyed()) return;
  const current = state.profiles.find(p => p.active);
  tray.setToolTip('Codex API Manager' + (current ? ` · ${current.name}` : ''));
  const groups = new Map();
  for (const p of state.profiles) {
    if (!groups.has(p.url)) groups.set(p.url, []);
    groups.get(p.url).push({ label: p.name.replace(/&/g, '&&'), type: 'checkbox', checked: p.active, enabled: p.hasKey,
      click: () => trayAction('switch', p.id) });
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showWindow },
    { label: '切换 API', submenu: groups.size ? [...groups].map(([url, submenu]) => ({ label: url.replace(/&/g, '&&'), submenu })) : [{ label: '暂无 API', enabled: false }] },
    { label: '重启 Codex', click: () => trayAction('restart') },
    { label: '收起到托盘', click: () => window?.hide() },
    { type: 'separator' }, { label: '退出', click: () => { if (controller.monitor.enabled) { showWindow(); window.close(); } else app.quit(); } },
  ]));
}
const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const trustedPage = pathToFileURL(htmlPath).href;
const executableDir = app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'))) : path.join(__dirname, '..');
const dataRoot = !app.isPackaged && process.env.CODEX_MANAGER_TEST_DATA ? process.env.CODEX_MANAGER_TEST_DATA : path.join(executableDir, 'data');
let storageError;
try {
  for (const folder of ['cache', 'cache/crashes', 'logs']) fsSync.mkdirSync(path.join(dataRoot, folder), { recursive: true });
  app.setPath('userData', path.join(dataRoot, 'cache'));
  app.setPath('sessionData', path.join(dataRoot, 'cache'));
  app.setPath('crashDumps', path.join(dataRoot, 'cache', 'crashes'));
  app.setAppLogsPath(path.join(dataRoot, 'logs'));
} catch { storageError = new Error('无法写入 EXE 旁的 data 文件夹，请把软件放到有写入权限的文件夹后重试。'); }
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    if (storageError) throw storageError;
    const { Manager } = await import('../core.mjs');
    const overrides = app.isPackaged ? {} : {
      ...(process.env.CODEX_MANAGER_TEST_HOME ? { codexHome: process.env.CODEX_MANAGER_TEST_HOME } : {}),
    };
    const { StorageSettings } = await import('../storage.mjs');
    storage = new StorageSettings(dataRoot, { portable: true });
    await storage.init();
    const { portableCodec } = await import('../portable.mjs');
    manager = new Manager({ ...overrides, dataDir: storage.settings.dataDir, codec: await portableCodec(dataRoot) });
    manager.storage = storage;
    await manager.init();
    const { MonitorController } = await import('../monitor.mjs');
    const { createMonitorRequester } = require('./monitor-transport.cjs');
    const monitorSession = session.fromPartition('codex-monitor-network');
    controller = new MonitorController(manager, { requester: createMonitorRequester(monitorSession) });
    await controller.init();
    const { TransferService } = await import('../transfer.mjs');
    transfer = new TransferService(manager, controller.monitor);
    const { Updater } = await import('../updater.mjs');
    const updateSession = session.fromPartition('codex-update-network');
    updater = new Updater({ version: app.getVersion(), root: path.join(dataRoot, 'cache', 'updates'),
      target: app.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE ? process.env.PORTABLE_EXECUTABLE_FILE : null,
      fetcher: (url, options) => updateSession.fetch(url, options) });
    await updater.cleanCompleted();
    await storage.record('startup');
    // Only the trusted editor can request a saved key; general state never includes secrets.
    ipcMain.handle('manager:request', async (event, route, data) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== trustedPage) {
        return { error: '不允许外部页面访问。' };
      }
      try {
        if (typeof route !== 'string' || JSON.stringify(data ?? {}).length > 32000) throw new Error('请求格式不正确。');
        if (route === 'metrics') return controller.monitor.summary();
        if (route === 'update-status') return updater.state();
        if (quitRequested) throw new Error('程序正在等待请求完成并退出。');
        if (route === 'check-update') return await updater.check();
        if (['downloading', 'installing'].includes(updater.status.phase)) throw new Error('软件正在更新，请稍候。');
        if (route === 'install-update') {
          await updater.prepare();
          updateRequested = true;
          setTimeout(() => app.quit(), 250);
          return { ok: true };
        }
        if (route === 'codex-status') {
          try {
            const target = await codexRestarter.probe();
            return { running: target.running, startedAt: target.startedAt ?? null };
          } catch { return { running: null, startedAt: null }; }
        }
        if (route === 'state') return await manager.exclusive(async () => {
          const state = { ...await controller.state(), settings: storage.state(), cacheDir: app.getPath('userData'), secretProtection: 'portable' };
          renderTray(state); return state;
        });
        const input = data || {};
        if (route === 'monitor' && input.enabled === false && controller.monitor.enabled) {
          const choice = await dialog.showMessageBox(window, { type: 'question', title: '关闭请求监控',
            message: '关闭监控并重启 Codex？',
            detail: '重启会关闭 Codex 窗口并中断请求；CLI 需自行重启。',
            buttons: ['关闭并重启 Codex', '仅关闭监控', '取消'], defaultId: 0, cancelId: 2 });
          if (choice.response === 2) return { canceled: true };
          return await manager.exclusive(async () => {
            await controller.setMonitoring(false);
            await storage.record('operation', { operation: 'monitor', outcome: 'ok' });
            let restarted = false, restartFailed = false;
            if (choice.response === 0) {
              try { await restartForDirectConnection(); restarted = true; }
              catch { restartFailed = true; await storage.record('operation', { operation: 'restart-codex', outcome: 'error' }); }
            }
            return { ok: true, result: { restarted, restartFailed } };
          });
        }
        if (route === 'hide-to-tray') { window.hide(); return { ok: true }; }
        if (route === 'list-models') return { ok: true, result: await manager.listModels(input, (url, options) => session.fromPartition('codex-model-network').fetch(url, options)) };
        if (route === 'test-connection') {
          const profile = manager.store.profiles.find(p => p.id === input.id);
          if (!profile?.encryptedKey) throw new Error('请先填写此 API 的 Key。');
          const confirmation = await dialog.showMessageBox(window, { type: 'question', title: '测试连接',
            message: `向“${profile.name}”发送一次“你好”？`,
            detail: `模型：${profile.model} · 会产生少量用量`,
            buttons: ['取消', '测试'], defaultId: 0, cancelId: 0 });
          if (confirmation.response !== 1) return { canceled: true };
          return { ok: true, result: await manager.exclusive(async () => {
            const current = manager.store.profiles.find(p => p.id === input.id);
            if (current !== profile) throw new Error('此 API 已被修改，请重新测试。');
            const result = await manager.testConnection(input.id);
            await storage.record('operation', { operation: route, outcome: result.status, profileId: input.id,
              status: result.httpStatus, durationMs: result.durationMs, errorKind: result.kind });
            return result;
          }) };
        }
        if (route === 'export-diagnostics') {
          const chosen = await dialog.showSaveDialog(window, { title: '导出诊断信息（不含 Key 和对话）',
            defaultPath: path.join(executableDir, 'codex-api-diagnostics.json'), filters: [{ name: '诊断信息', extensions: ['json'] }] });
          if (chosen.canceled) return { canceled: true };
          const { exportDiagnostics } = await import('../support.mjs');
          await manager.exclusive(() => exportDiagnostics(chosen.filePath, manager, storage, controller.monitor, app.getVersion()));
          await storage.record('operation', { operation: route, outcome: 'ok' });
          return { ok: true };
        }
        if (route === 'restart-codex') {
          if (restartingCodex) throw new Error('Codex 正在重启，请稍候。');
          restartingCodex = true;
          try {
            const target = await codexRestarter.probe();
            const confirmation = await dialog.showMessageBox(window, { type: 'question', title: '重启 Codex',
              message: target.running ? '重启 Codex？' : '打开 Codex？',
              detail: target.running ? '将关闭所有窗口并中断请求。' : '',
              buttons: ['取消', target.running ? '重启' : '打开'], defaultId: 0, cancelId: 0 });
            if (confirmation.response !== 1) return { canceled: true };
            const result = await manager.exclusive(() => codexRestarter.restart(target));
            await storage.record('operation', { operation: 'restart-codex', outcome: 'ok' });
            return { ok: true, result };
          } catch (error) {
            await storage.record('operation', { operation: 'restart-codex', outcome: 'error' });
            throw error;
          } finally { restartingCodex = false; }
        }
        if (route === 'discard-import') { transfer.discard(); return { ok: true }; }
        if (route === 'preview-import') {
          transfer.discard();
          const chosen = await dialog.showOpenDialog(window, { title: '导入配置', properties: ['openFile'], filters: [{ name: 'API 配置', extensions: ['json'] }] });
          if (chosen.canceled) return { canceled: true };
          return { preview: await manager.exclusive(() => transfer.openFile(chosen.filePaths[0])) };
        }
        if (route === 'apply-import') {
          const result = await manager.exclusive(() => transfer.apply(input));
          await storage.record('operation', { operation: 'import', outcome: 'ok' });
          return { ok: true, result };
        }
        if (route === 'export-profiles') {
          const chosen = await dialog.showSaveDialog(window, { title: '导出配置', defaultPath: path.join(executableDir, 'codex-api-profiles.json'), filters: [{ name: 'API 配置', extensions: ['json'] }] });
          if (chosen.canceled) return { canceled: true };
          const result = await manager.exclusive(() => transfer.exportTo(chosen.filePath, input.ids));
          await storage.record('operation', { operation: 'export', outcome: 'ok' });
          return { ok: true, result };
        }
        if (route === 'open-directory') {
          const folders = { data: manager.dataDir, logs: storage.logDir, config: manager.home, settings: storage.root, cache: app.getPath('userData') };
          if (!Object.hasOwn(folders, input.kind)) throw new Error('目录类型无效。');
          await fs.mkdir(folders[input.kind], { recursive: true });
          if (await shell.openPath(folders[input.kind])) throw new Error('无法打开文件夹。');
          return { ok: true };
        }
        if (route === 'settings') return { ok: true, result: await manager.exclusive(() => storage.update(input, manager, controller.monitor)) };
        if (route === 'clear-logs') {
          const result = await dialog.showMessageBox(window, { type: 'question', title: '清空日志', message: '删除当前数据目录中的所有运行日志？', buttons: ['取消', '清空日志'], defaultId: 0, cancelId: 0 });
          if (result.response === 1) await manager.exclusive(() => storage.clearLogs());
          return { ok: true, cleared: result.response === 1 };
        }
        const actions = {
          'read-key': async () => ({ key: await manager.readKey(input.id) }),
          save: () => controller.save(input), delete: () => controller.remove(input.id),
          switch: () => controller.switchTo(input.id), restore: () => controller.restore(),
          monitor: () => controller.setMonitoring(input.enabled === true),
          import: async () => { if (!await controller.importCurrent()) throw new Error('当前 Codex 没有可导入的 API 地址和 Key。'); },
          refresh: () => manager.refresh(input.id),
        };
        if (!Object.hasOwn(actions, route)) throw new Error('不存在的操作。');
        const result = await manager.exclusive(async () => {
          try {
            const value = await actions[route]();
            await storage.record('operation', { operation: route, outcome: route === 'refresh' ? value.status : 'ok', profileId: input.id });
            return value;
          } catch (e) { await storage.record('operation', { operation: route, outcome: 'error', profileId: input.id }); throw e; }
        });
        return { ok: true, result };
      } catch (error) { return { error: error.code ? '读取或保存本地文件失败，请检查文件权限。' : error.message }; }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({ width: 1040, height: 820, minWidth: 560, minHeight: 600,
      title: 'Codex API Manager', icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#f4f6f5', show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    window.removeMenu();
    tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.ico'));
    tray.on('double-click', showWindow);
    renderTray(await controller.state());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== trustedPage) event.preventDefault(); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    window.on('close', event => {
      if (!finishingQuit && !quitRequested && !confirmedWindowExit) {
        event.preventDefault();
        if (closePrompt) return;
        closePrompt = true;
        dialog.showMessageBox(window, { type: 'question', title: '关闭窗口',
          message: '选择关闭方式',
          buttons: ['缩小到托盘', '退出应用', '取消'], defaultId: 0, cancelId: 2,
        }).then(result => {
          if (result.response === 0) window?.hide();
          else if (result.response === 1) {
            confirmedWindowExit = true; app.quit();
          }
        }).catch(() => {}).finally(() => { closePrompt = false; });
        return;
      }
      if (!finishingQuit && (controller.monitor.enabled || controller.monitor.active.size || ['downloading', 'installing'].includes(updater?.status.phase))) { event.preventDefault(); app.quit(); }
    });
    window.on('closed', () => { window = null; });
    await window.loadFile(htmlPath);
    if (app.isPackaged && !process.env.CODEX_MANAGER_TEST_DATA) {
      const check = () => { if (storage.settings.autoUpdates !== false && !quitRequested) updater.check().catch(() => {}); };
      setTimeout(check, 2000).unref();
      setInterval(check, 6 * 60 * 60 * 1000).unref();
    }
  }).catch(error => {
    dialog.showErrorBox('Codex API Manager', error.code ? '无法启动，请检查本机数据目录的文件权限。' : error.message);
    app.quit();
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!manager || finishingQuit) return;
  event.preventDefault();
  if (updater?.status.phase === 'downloading') return;
  if (quitRequested) return;
  quitRequested = true;
  if (window) window.setTitle('Codex API 管理 · 正在等待请求完成');
  manager.exclusive(async () => {
    const wasMonitoring = controller?.monitor.enabled;
    transfer?.discard(); await controller?.monitor.shutdown();
    if (wasMonitoring && !updateRequested) {
      const choice = await dialog.showMessageBox(window, { type: 'info', title: '监控已自动关闭',
        message: '重启 Codex 使配置生效？',
        detail: '重启会关闭 Codex 窗口；CLI 需自行重启。',
        buttons: ['立即重启 Codex', '稍后自行重启'], defaultId: 0, cancelId: 1 });
      restartAfterShutdown = choice.response === 0;
    }
    if (restartAfterShutdown) { await restartForDirectConnection(); restartAfterShutdown = false; }
    await storage?.record('shutdown');
    if (updateRequested) await updater.launchInstaller();
  }).then(() => { finishingQuit = true; tray?.destroy(); app.quit(); }).catch(error => {
    quitRequested = false;
    confirmedWindowExit = false;
    if (restartAfterShutdown && !controller?.monitor.enabled) {
      restartAfterShutdown = false;
      showWindow();
      dialog.showMessageBox(window, { type: 'warning', title: '监控已关闭', message: 'Codex 重启失败，请手动重启。', buttons: ['知道了'] }).catch(() => {});
      return;
    }
    if (updateRequested) {
      updateRequested = false;
      updater.status.phase = 'error'; updater.status.message = '暂时无法完成更新，旧版本已保留；请等待请求结束后重试。';
      if (window) window.setTitle('Codex API 管理');
      return;
    }
    if (window) window.setTitle('Codex API 管理');
    dialog.showMessageBox({ type: 'warning', title: '监控恢复失败',
      message: '配置恢复失败。保留备份退出后，可重新打开工具重试。',
      buttons: ['返回', '保留备份并退出'], defaultId: 0, cancelId: 0 }).then(result => {
      if (result.response === 1) { finishingQuit = true; app.quit(); }
    });
  });
});
