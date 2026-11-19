const { app, BrowserWindow, ipcMain, dialog, session, shell, Tray, Menu } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const codexRestarter = require('./restart-codex.cjs');
const displayName = 'API 切换台';
app.setName(displayName);

let window;
let manager;
let controller;
let storage;
let transfer;
let claudeTransfer;
let claudeMonitor;
let sessionRepair;
let autoSessionRepair;
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
function trayAction(action, id, client) {
  showWindow();
  if (!quitRequested && window && !window.webContents.isDestroyed()) window.webContents.send('manager:tray-action', { action, id, client });
}
let codexTrayState, claudeTrayState;
function renderTray(state, client = 'codex') {
  if (!tray || tray.isDestroyed()) return;
  if (client === 'claude') claudeTrayState = state; else codexTrayState = state;
  const current = codexTrayState?.profiles.find(p => p.active);
  tray.setToolTip(displayName + (current ? ` · ${current.name}` : ''));
  function group(profiles, target) {
    const groups = new Map();
    for (const p of profiles || []) {
      if (!groups.has(p.url)) groups.set(p.url, []);
      groups.get(p.url).push({ label: p.name.replace(/&/g, '&&'), type: 'checkbox', checked: p.active, enabled: p.hasKey,
        click: () => trayAction('switch', p.id, target) });
    }
    return groups.size ? [...groups].map(([url, submenu]) => ({ label: url.replace(/&/g, '&&'), submenu })) : [{ label: '暂无 API', enabled: false }];
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: showWindow },
    { label: '切换 Codex API', submenu: group(codexTrayState?.profiles, 'codex') },
    { label: '切换 Claude API', submenu: group(claudeTrayState?.profiles, 'claude') },
    { label: '重启 Codex', click: () => trayAction('restart') },
    { label: '打开 Claude Code CLI', click: () => trayAction('restart', undefined, 'claude') },
    { label: '收起到托盘', click: () => window?.hide() },
    { type: 'separator' }, { label: '退出', click: () => { if (controller.monitor.enabled) { showWindow(); window.close(); } else app.quit(); } },
  ]));
}
// 新版界面：设置环境变量 CODEX_MANAGER_UI=v2 后启用 public/v2，默认仍为旧版界面。
const htmlPath = path.join(__dirname, '..', 'public', ...(process.env.CODEX_MANAGER_UI === 'v2' ? ['v2', 'index.html'] : ['index.html']));
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
    const { ClaudeManager, ClaudeMonitor, claudeProfile } = await import('../claude.mjs');
    const claude = new ClaudeManager({ dataDir: manager.dataDir, codec: manager.codec });
    await claude.init();
    claude.storage = storage;
    claudeMonitor = new ClaudeMonitor(claude, { requester: createMonitorRequester(session.fromPartition('claude-monitor-network')) });
    await claudeMonitor.recover().catch(() => { claudeMonitor.recoveryWarning = 'Claude 监控配置未自动恢复，请检查 Claude 用户设置并重新打开工具。'; });
    transfer = new TransferService(manager, controller.monitor, { protectedHomes: [claude.home] });
    claudeTransfer = new TransferService(claude, claudeMonitor, { format: 'claude-code-api-manager', validate: claudeProfile,
      serialize: ({ name, url, model, auth, adapter }) => ({ name, url, model, auth, adapter: adapter ?? 'auto' }), protectedHomes: [manager.home] });
    const { SessionRepair } = await import('../session-repair.mjs');
    sessionRepair = new SessionRepair(manager);
    const { AutoSessionRepair } = await import('../auto-session-repair.mjs');
    autoSessionRepair = new AutoSessionRepair(manager, storage, controller.monitor, {
      canRun: () => !quitRequested && !restartingCodex && !['downloading', 'installing'].includes(updater?.status.phase),
      onChange: value => { if (window && !window.webContents.isDestroyed()) window.webContents.send('manager:auto-session-repair', value); },
    });
    await autoSessionRepair.init();
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
        const input = data || {};
        const isClaude = input.client === 'claude';
        const targetManager = isClaude ? claude : manager, targetMonitor = isClaude ? claudeMonitor : controller.monitor;
        if (route === 'metrics') return targetMonitor.summary();
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
        if (route === 'state') return await targetManager.exclusive(async () => {
          const current = isClaude ? await claude.state() : await controller.state();
          if (isClaude && claudeMonitor.enabled) {
            for (const p of current.profiles) p.active = p.id === claudeMonitor.profile.id;
            current.current = { url: claudeMonitor.profile.url, model: claudeMonitor.profile.model };
            current.canRestore = false;
          }
          renderTray(current, isClaude ? 'claude' : 'codex');
          return { ...current, monitor: targetMonitor.summary(), settings: storage.state(), cacheDir: app.getPath('userData'), secretProtection: 'portable' };
        });
        if (isClaude && route === 'monitor') {
          return { ok: true, result: await claude.exclusive(async () => {
            if (input.enabled === true && !claudeMonitor.enabled) {
              const active = (await claude.state()).profiles.find(p => p.active);
              await claudeMonitor.enable(active?.id);
            } else if (input.enabled === false) await claudeMonitor.disable();
          }) };
        }
        if (route === 'auto-session-repair-status') return autoSessionRepair.state();
        if (route === 'auto-session-repair-details') return autoSessionRepair.details();
        if (route === 'global-provider-options') return await manager.exclusive(async () => {
          const result = await manager.globalProviderOptions();
          try { result.options = [...new Set([...result.options, ...await sessionRepair.providerIds()])].sort(); } catch { /* Configuration options remain usable if history is unavailable. */ }
          return result;
        });
        if (route === 'set-global-provider') return await manager.exclusive(async () => {
          if (controller.monitor.enabled || controller.monitor.active.size || controller.monitor.recoveryWarning) throw new Error('请先关闭请求监控并等待请求结束。');
          await manager.setGlobalProvider(input.id, input.revision);
          autoSessionRepair.requestCheck();
          return { ok: true };
        });
        if (route === 'check-auto-session-repair') {
          autoSessionRepair.requestCheck(); await autoSessionRepair.tick(); return autoSessionRepair.state();
        }
        if (route === 'release-session-repair') { autoSessionRepair.release(); return { ok: true }; }
        if (route === 'auto-session-repair-settings') return await manager.exclusive(async () => {
          if (typeof input.enabled !== 'boolean') throw new Error('自动兼容设置无效。');
          await storage.update({ ...storage.settings, autoSessionRepair: input.enabled }, manager, controller.monitor);
          autoSessionRepair.reset();
          setImmediate(() => autoSessionRepair.tick().catch(() => {}));
          return autoSessionRepair.state();
        });
        if (route === 'exclude-session-repair') return await manager.exclusive(async () => {
          if (typeof input.excluded !== 'boolean' || !sessionRepair.preview?.candidates.has(input.id)) throw new Error('请重新扫描后设置排除对话。');
          const ids = new Set(storage.settings.sessionRepairExclusions || []);
          if (input.excluded) ids.add(input.id); else ids.delete(input.id);
          await storage.update({ ...storage.settings, sessionRepairExclusions: [...ids] }, manager, controller.monitor);
          autoSessionRepair.reset(); return autoSessionRepair.state();
        });
        if (['scan-session-repair', 'apply-session-repair', 'undo-session-repair'].includes(route)) {
          autoSessionRepair.hold();
          return await manager.exclusive(async () => {
            if (route === 'scan-session-repair') return { result: { ...await sessionRepair.scan({ targetProvider: 'codex_api_manager', includeAligned: true }), exclusions: [...(storage.settings.sessionRepairExclusions || [])] } };
            if (controller.monitor.enabled) throw new Error('请先关闭请求监控，再修复或撤回旧对话连接。');
            const entries = route === 'apply-session-repair' ? (input.ids || []).map(id => sessionRepair.preview?.candidates.get(id)).filter(Boolean) : [];
            const target = sessionRepair.preview?.config.target;
            const result = route === 'apply-session-repair' ? await sessionRepair.apply(input) : await sessionRepair.undo();
            if (route === 'apply-session-repair') await autoSessionRepair.record(result, entries, 'manual', target);
            else await autoSessionRepair.recordUndo(result);
            if (route === 'undo-session-repair' && storage.settings.autoSessionRepair) {
              await storage.update({ ...storage.settings, autoSessionRepair: false }, manager, controller.monitor);
              autoSessionRepair.reset();
            }
            await storage.record('operation', { operation: route, outcome: 'ok' });
            return { result };
          });
        }
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
        if (route === 'open-claude-cli' && isClaude) {
          await new Promise((resolve, reject) => execFile('where.exe', ['claude'], { windowsHide: true, timeout: 5000 },
            error => error ? reject(new Error('未在 PATH 找到 Claude Code，请从已配置的终端运行 claude。')) : resolve()));
          const child = spawn('cmd.exe', ['/d', '/k', 'claude'], { cwd: app.getPath('home'), detached: true, stdio: 'ignore', windowsHide: false });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('无法打开 Claude Code CLI。'))); });
          child.unref(); return { ok: true };
        }
        if (route === 'list-models') return { ok: true, result: await targetManager.listModels(input, (url, options) => session.fromPartition(isClaude ? 'claude-model-network' : 'codex-model-network').fetch(url, options)) };
        if (route === 'test-connection') {
          const profile = targetManager.store.profiles.find(p => p.id === input.id);
          if (!profile?.encryptedKey) throw new Error('请先填写此 API 的 Key。');
          if (!profile.model) throw new Error('请先查询并选择模型，或手动填写模型 ID。');
          const confirmation = await dialog.showMessageBox(window, { type: 'question', title: '测试连接',
            message: `向“${profile.name}”发送一次“你好”？`,
            detail: `模型：${profile.model} · 会产生少量用量`,
            buttons: ['取消', '测试'], defaultId: 0, cancelId: 0 });
          if (confirmation.response !== 1) return { canceled: true };
          return { ok: true, result: await targetManager.exclusive(async () => {
            const current = targetManager.store.profiles.find(p => p.id === input.id);
            if (current !== profile) throw new Error('此 API 已被修改，请重新测试。');
            const result = await targetManager.testConnection(input.id);
            await storage.record('operation', { operation: route, outcome: result.status, profileId: input.id,
              status: result.httpStatus, durationMs: result.durationMs, errorKind: result.kind });
            return result;
          }) };
        }
        if (route === 'export-diagnostics') {
          const chosen = await dialog.showSaveDialog(window, { title: '导出诊断信息（不含 Key 和对话）',
            defaultPath: path.join(executableDir, isClaude ? 'claude-api-diagnostics.json' : 'codex-api-diagnostics.json'), filters: [{ name: '诊断信息', extensions: ['json'] }] });
          if (chosen.canceled) return { canceled: true };
          const { exportDiagnostics } = await import('../support.mjs');
          await targetManager.exclusive(() => exportDiagnostics(chosen.filePath, targetManager, storage, targetMonitor, app.getVersion(), [isClaude ? manager.home : claude.home]));
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
        const selectedTransfer = input.client === 'claude' ? claudeTransfer : transfer;
        const selectedManager = input.client === 'claude' ? claude : manager;
        if (route === 'discard-import') { selectedTransfer.discard(); return { ok: true }; }
        if (route === 'preview-import') {
          selectedTransfer.discard();
          const chosen = await dialog.showOpenDialog(window, { title: '导入配置', properties: ['openFile'], filters: [{ name: 'API 配置', extensions: ['json'] }] });
          if (chosen.canceled) return { canceled: true };
          return { preview: await selectedManager.exclusive(() => selectedTransfer.openFile(chosen.filePaths[0])) };
        }
        if (route === 'apply-import') {
          const result = await selectedManager.exclusive(() => selectedTransfer.apply(input));
          await storage.record('operation', { operation: 'import', outcome: 'ok' });
          return { ok: true, result };
        }
        if (route === 'export-profiles') {
          const chosen = await dialog.showSaveDialog(window, { title: '导出配置', defaultPath: path.join(executableDir, input.client === 'claude' ? 'claude-api-profiles.json' : 'codex-api-profiles.json'), filters: [{ name: 'API 配置', extensions: ['json'] }] });
          if (chosen.canceled) return { canceled: true };
          const result = await selectedManager.exclusive(() => selectedTransfer.exportTo(chosen.filePath, input.ids));
          await storage.record('operation', { operation: 'export', outcome: 'ok' });
          return { ok: true, result };
        }
        if (route === 'open-directory') {
          const folders = { data: manager.dataDir, logs: storage.logDir, config: targetManager.home, settings: storage.root, cache: app.getPath('userData') };
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
        const actions = isClaude ? {
          'read-key': async () => ({ key: await claude.readKey(input.id) }),
          save: () => {
            if (claudeMonitor.enabled && input.id === claudeMonitor.profile.id) throw new Error('请先关闭 Claude 请求监控，再编辑当前 API。');
            return claude.save(input);
          },
          delete: () => {
            if (claudeMonitor.enabled && input.id === claudeMonitor.profile.id) throw new Error('无法删除正在监控的 API。');
            return claude.remove(input.id);
          },
          'undo-delete': () => claude.undoRemove(input.token), favorite: () => claude.setFavorite(input.id, input.favorite),
          switch: async () => {
            if (claudeMonitor.recoveryWarning) throw new Error(claudeMonitor.recoveryWarning);
            const monitored = claudeMonitor.enabled;
            if (monitored) await claudeMonitor.disable();
            await claude.switchTo(input.id);
            if (monitored) await claudeMonitor.enable(input.id);
          },
          restore: () => { if (claudeMonitor.enabled) throw new Error('请先关闭 Claude 请求监控。'); return claude.restore(); },
          import: async () => { if (claudeMonitor.enabled || !await claude.importCurrent()) throw new Error('请先关闭 Claude 请求监控，并配置自定义网关与 Key。'); },
          refresh: () => claude.refresh(input.id),
        } : {
          'read-key': async () => ({ key: await manager.readKey(input.id) }),
          save: () => controller.save(input), delete: () => controller.remove(input.id),
          'undo-delete': () => manager.undoRemove(input.token), favorite: () => manager.setFavorite(input.id, input.favorite),
          switch: () => controller.switchTo(input.id), restore: () => controller.restore(),
          monitor: () => controller.setMonitoring(input.enabled === true),
          import: async () => { if (!await controller.importCurrent()) throw new Error('当前 Codex 没有可导入的 API 地址和 Key。'); },
          refresh: () => manager.refresh(input.id),
        };
        if (!Object.hasOwn(actions, route)) throw new Error('不存在的操作。');
        const result = await targetManager.exclusive(async () => {
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
      title: displayName, icon: path.join(__dirname, '..', 'assets', 'icon.png'), backgroundColor: '#f4f6f5', show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
    });
    window.removeMenu();
    tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.ico'));
    tray.on('double-click', showWindow);
    renderTray(await controller.state());
    await claude.state().then(s => renderTray(s, 'claude')).catch(() => {});
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
      if (!finishingQuit && (controller.monitor.enabled || controller.monitor.active.size || claudeMonitor.enabled || claudeMonitor.active.size || ['downloading', 'installing'].includes(updater?.status.phase))) { event.preventDefault(); app.quit(); }
    });
    window.on('closed', () => { window = null; });
    await window.loadFile(htmlPath);
    setTimeout(() => autoSessionRepair.tick().catch(() => {}), 3000).unref();
    setInterval(() => autoSessionRepair.tick().catch(() => {}), 5000).unref();
    if (app.isPackaged && !process.env.CODEX_MANAGER_TEST_DATA) {
      const check = () => { if (storage.settings.autoUpdates !== false && !quitRequested) updater.check().catch(() => {}); };
      setTimeout(check, 2000).unref();
      setInterval(check, 6 * 60 * 60 * 1000).unref();
    }
  }).catch(error => {
    dialog.showErrorBox(displayName, error.code ? '无法启动，请检查本机数据目录的文件权限。' : error.message);
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
  if (window) window.setTitle(`${displayName} · 正在等待请求完成`);
  manager.exclusive(async () => {
    const wasMonitoring = controller?.monitor.enabled;
    const wasClaudeMonitoring = claudeMonitor?.enabled;
    transfer?.discard(); claudeTransfer?.discard(); await controller?.monitor.shutdown();
    if (claudeMonitor) await claudeMonitor.manager.exclusive(() => claudeMonitor.shutdown());
    if (wasClaudeMonitoring && !updateRequested) await dialog.showMessageBox(window, { type: 'info', title: 'Claude 监控已关闭',
      message: '请重新打开 Claude Code CLI，以恢复直连。', buttons: ['知道了'] });
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
      if (window) { window.setTitle(displayName); window.webContents.send('manager:tray-action', { action: 'monitor-stopped' }); }
      dialog.showMessageBox(window, { type: 'warning', title: '监控已关闭', message: 'Codex 重启失败，请手动重启。', buttons: ['知道了'] }).catch(() => {});
      return;
    }
    if (updateRequested) {
      updateRequested = false;
      updater.status.phase = 'error'; updater.status.message = '暂时无法完成更新，旧版本已保留；请等待请求结束后重试。';
      if (window) window.setTitle(displayName);
      return;
    }
    if (window) window.setTitle(displayName);
    dialog.showMessageBox({ type: 'warning', title: '监控恢复失败',
      message: '配置恢复失败。保留备份退出后，可重新打开工具重试。',
      buttons: ['返回', '保留备份并退出'], defaultId: 0, cancelId: 0 }).then(result => {
      if (result.response === 1) { finishingQuit = true; app.quit(); }
    });
  });
});
