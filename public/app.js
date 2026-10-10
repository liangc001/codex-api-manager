const $ = id => document.getElementById(id);
let state, editingId = null, busy = false, metricsBusy = false, noticeTimer;
let transferMode, transferPreview;
let editorGeneration = 0, editorKeyChanged = false;
let guideInitialized = false;
let guideStep = 0, guideProfileId = null;
let restartNeeded = false, restartDismissed = false, restartBaseline = null;
let restartChangedAt = 0, restartStatusBusy = false;
try {
  restartNeeded = localStorage.getItem('restart-needed') === '1';
  restartBaseline = localStorage.getItem('restart-baseline');
  restartChangedAt = Number(localStorage.getItem('restart-changed-at')) || 0;
} catch {}
function rememberRestartBaseline(revision) {
  if (!revision) return;
  restartBaseline = revision;
  try { localStorage.setItem('restart-baseline', revision); } catch {}
}
function renderRestartReminder() {
  const visible = restartNeeded && !!window.codexManager && !restartDismissed && !guideStep;
  $('restart-reminder').hidden = !visible;
  document.body.classList.toggle('restart-floating-open', visible);
}
function markConnectionChange() {
  if (!restartNeeded) rememberRestartBaseline(state.current.connectionRevision);
  setRestartNeeded(true);
}
function setRestartNeeded(value) {
  restartNeeded = value; restartDismissed = false;
  restartChangedAt = value ? Date.now() : 0;
  try {
    localStorage.setItem('restart-needed', value ? '1' : '0');
    localStorage.setItem('restart-changed-at', String(restartChangedAt));
  } catch {}
  if (!value && state) rememberRestartBaseline(state.current.connectionRevision);
  renderRestartReminder();
}
async function reconcileRestartReminder() {
  if (!restartNeeded || !window.codexManager || restartStatusBusy) return;
  // Old releases had only a sticky flag, with no evidence that a restart is still pending.
  if (!restartChangedAt || state?.current.connectionRevision === restartBaseline) {
    setRestartNeeded(false); return;
  }
  restartStatusBusy = true;
  const checkedAt = restartChangedAt;
  try {
    const status = await api('codex-status');
    if (restartChangedAt === checkedAt && (status.running === false || (Number.isFinite(status.startedAt) && status.startedAt >= checkedAt))) setRestartNeeded(false);
  } catch {} finally { restartStatusBusy = false; }
}
window.addEventListener('focus', () => { if (state && !busy) reconcileRestartReminder(); });
function errorHint(message) {
  if (/401|Key 无效|认证失败/.test(message)) return '检查 Key、服务商地址和所属分组。';
  if (/403|权限/.test(message)) return '在服务商后台检查 Key 的调用或查询权限。';
  if (/429|限流/.test(message)) return '上游限流，稍后重试或更换服务商分组。';
  if (/model.*not supported|模型.*(?:不支持|不可用)/i.test(message)) return '检查模型名称及上游分组的模型权限。';
  if (/证书|连接失败|超时/.test(message)) return '检查网络、代理和 HTTPS 地址；必要时联系服务商。';
  if (/跳转/.test(message)) return '填写服务商最终 API 地址。';
  return '';
}
function startGuide() {
  guideStep = 1; guideProfileId = null;
  try { localStorage.setItem('quick-guide-dismissed', '1'); } catch {}
  renderGuide();
}
function exitGuide() {
  guideStep = 0; guideProfileId = null;
  try { localStorage.setItem('quick-guide-dismissed', '1'); } catch {}
  $('quick-guide').querySelector('details').open = false;
  renderGuide();
}
function renderGuide() {
  if (guideStep > 1 && !state?.profiles.some(p => p.id === guideProfileId && p.hasKey)) {
    guideStep = 1; guideProfileId = null;
  }
  const selected = state?.profiles.find(p => p.id === guideProfileId);
  if (guideStep === 3 && selected && !selected.active) guideStep = 2;
  $('quick-guide').hidden = !guideStep;
  $('help').setAttribute('aria-expanded', String(!!guideStep));
  document.body.classList.toggle('tutorial-open', !!guideStep);
  const descriptions = ['', '填写地址、Key 和模型，保存你的 API。',
    `切换到“${selected?.name || ''}”。`,
    window.codexManager ? '重启 Codex，让新配置生效。' : '重新打开 Codex App 或 CLI。',
    '去 Codex 发送“你好”，开始使用。'];
  $('guide-title').textContent = ['', '添加 API', '切换连接', '重启 Codex', '准备就绪'][guideStep];
  $('guide-status').textContent = descriptions[guideStep];
  $('guide-progress').textContent = guideStep === 4 ? '已完成' : `第 ${guideStep} / 3 步`;
  $('guide-done').textContent = guideStep === 4 ? '完成教程' : '退出教程';
  $('guide-add').hidden = !guideStep || guideStep === 4 || (guideStep === 3 && !window.codexManager);
  $('guide-add').lastChild.textContent = ['', '添加 API', '切换 API', '重启 Codex'][guideStep] || '';
  $('guide-cli-done').hidden = guideStep !== 3 || !!window.codexManager;
  for (const [i, node] of [...document.querySelectorAll('.guide-steps li')].entries()) {
    node.classList.toggle('guide-current', guideStep === i + 1);
    node.classList.toggle('guide-complete', guideStep > i + 1);
    if (guideStep === i + 1) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
  }
  document.querySelectorAll('.tutorial-target').forEach(n => n.classList.remove('tutorial-target'));
  let target;
  const editorActive = guideStep === 1 && $('editor').open && !editingId;
  $('quick-guide').classList.toggle('guide-in-editor', editorActive);
  $('editor-guide').hidden = !editorActive;
  $('profile-form').elements.key.required = editorActive;
  if (guideStep === 1) target = editorActive ? $('profile-form').querySelector('[type="submit"]') : $('add');
  if (guideStep === 2) target = [...document.querySelectorAll('.profile')].find(n => n.dataset.id === guideProfileId)?.querySelector('.switch-button');
  if (guideStep === 3 && window.codexManager) target = $('restart-codex');
  if (target) { target.classList.add('tutorial-target'); if (guideStep === 2) target.disabled = false; }
  icons();
  renderRestartReminder();
}
$('help').onclick = () => { if (guideStep) exitGuide(); else startGuide(); };
$('close-guide').onclick = $('guide-done').onclick = $('exit-editor-guide').onclick = exitGuide;
$('guide-add').onclick = () => {
  if (busy) return;
  if (guideStep === 1) openEditor();
  else if (guideStep === 2) [...document.querySelectorAll('.profile')].find(n => n.dataset.id === guideProfileId)?.querySelector('.switch-button')?.click();
  else if (guideStep === 3) $('restart-codex').click();
};
$('guide-cli-done').onclick = () => { guideStep = 4; renderGuide(); };
const token = document.querySelector('meta[name="manager-token"]').content;
const icons = () => lucide.createIcons();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const icon = name => { const e = el('i'); e.dataset.lucide = name; return e; };
function button(name, title, action, text, cls = 'icon') {
  const b = el('button', cls); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.append(icon(name));
  if (text) b.append(el('span', '', text)); b.onclick = action; return b;
}
async function api(route, data) {
  if (window.codexManager) {
    const result = await window.codexManager.request(route, data);
    if (result.error) throw new Error(result.error);
    return result;
  }
  const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'X-Manager-Token': token, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作失败'); return result;
}
function notice(text, error = false) {
  clearTimeout(noticeTimer);
  const hint = error ? errorHint(text) : '';
  $('notice').textContent = text + (hint ? ` ${hint}` : ''); $('notice').className = 'notice' + (error ? ' error' : ''); $('notice').hidden = false;
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
async function load() {
  state = await api('state');
  if (!guideInitialized) await reconcileRestartReminder();
  render(); renderMetrics(state.monitor);
  if (!restartNeeded) rememberRestartBaseline(state.current.connectionRevision);
  if (!guideInitialized) {
    guideInitialized = true;
    let dismissed = false;
    try { dismissed = localStorage.getItem('quick-guide-dismissed') === '1'; } catch {}
    if (!state.profiles.length && !dismissed) startGuide();
  }
  renderGuide();
}
async function run(fn) {
  if (busy) return;
  busy = true; document.body.classList.add('busy');
  try { await fn(); await load(); } catch (e) { notice(e.message, true); }
  finally { busy = false; document.body.classList.remove('busy'); }
}
function metric(label, value, unit) {
  const d = el('div', 'metric'); d.append(el('span', '', label));
  const strong = el('strong', '', value); if (unit) strong.append(el('small', '', unit)); d.append(strong); return d;
}
function number(v) { return v == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(v); }
function renderUsage(p) {
  if (!p.hasKey || p.adapter === 'none') return document.createDocumentFragment();
  const row = el('div', 'usage'); const u = p.usage;
  if (u?.status === 'ok') {
    const metrics = el('div', 'usage-metrics');
    metrics.append(metric(u.scope || '剩余', u.unlimited ? '无限额' : number(u.remaining), u.unlimited ? '' : u.unit));
    if (u.used != null) metrics.append(metric('累计使用', number(u.used), u.unit));
    if (u.today != null) metrics.append(metric('今日花费', number(u.today), u.unit));
    if (u.tokens != null) metrics.append(metric('今日 Token', number(u.tokens)));
    const windowNames = { daily: '日额度', weekly: '周额度', monthly: '月额度', '5h': '5h 额度', '1d': '日额度', '7d': '周额度' };
    for (const w of [...(u.windows || []), ...(u.subscription || [])]) metrics.append(metric(windowNames[w.name] || w.name, `${number(w.used)} / ${number(w.limit)}`, u.unit));
    row.append(metrics);
  } else row.append(el('span', 'usage-message' + (u?.status === 'error' ? ' error' : ''), u?.message || '未查询'));
  const right = el('div', 'usage-right');
  if (u?.checkedAt) right.append(el('span', 'usage-time', new Date(u.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })));
  if (u?.checkedAt) right.title = '查询时间：' + new Date(u.checkedAt).toLocaleString('zh-CN');
  const refresh = button('refresh-cw', '刷新此 API 用量', () => refreshOne(p)); refresh.disabled = !p.hasKey || p.adapter === 'none'; right.append(refresh); row.append(right); return row;
}
function render() {
  const active = state.profiles.find(p => p.active);
  $('current-name').textContent = active?.name || (state.current.url ? 'Codex 当前连接' : '尚未配置');
  $('current-url').textContent = state.current.url || '—'; $('current-model').textContent = state.current.model || '';
  $('count').textContent = state.profiles.length;
  $('restore').disabled = !state.canRestore;
  $('settings').hidden = !state.settings;
  $('restart-codex').hidden = !window.codexManager;
  renderRestartReminder();
  $('import-file').hidden = $('export-file').hidden = !window.codexManager;
  $('export-file').disabled = !state.profiles.length;
  $('conflicts').hidden = !state.conflicts.length;
  $('conflicts').textContent = `环境变量可能覆盖连接：${state.conflicts.join('、')}`;
  $('profiles').replaceChildren();
  const groups = new Map();
  for (const p of state.profiles) {
    const url = new URL(p.url).href.replace(/\/+$/, '');
    if (!groups.has(url)) {
      const section = el('section', 'profile-group'); section.setAttribute('aria-label', url);
      const heading = el('div', 'profile-group-heading');
      heading.append(el('h3', 'mono', url), el('span', 'profile-group-count'));
      const list = el('div', 'profile-group-list');
      section.append(heading, list); $('profiles').append(section);
      groups.set(url, { heading, list, count: 0 });
    }
    const group = groups.get(url);
    group.heading.lastChild.textContent = `${++group.count} 个 API`;
    const article = el('article', 'profile' + (p.active ? ' active' : '')); article.dataset.id = p.id;
    const info = el('div'); const title = el('div', 'profile-title'); title.append(el('h3', '', p.name));
    if (!p.hasKey) title.append(el('span', 'badge empty', '未填写 Key'));
    info.append(title);
    const meta = el('div', 'profile-meta'); meta.append(el('span', '', p.model), el('span', '', p.effort));
    const concurrent = el('span', 'provider-concurrent'); concurrent.dataset.providerCount = p.id; meta.append(concurrent); info.append(meta);
    const actions = el('div', 'profile-actions');
    const needsSync = p.active && state.current.needsLegacySync;
    const switcher = button('arrow-right-left', needsSync ? '同步旧对话连接' : p.active ? '已配置为当前 API' : '切换到此 API', () => {
      if (!p.hasKey) { openEditor(p); return; }
      run(async () => {
        await api('switch', { id: p.id });
        markConnectionChange();
        if (guideStep >= 2) guideStep = p.id === guideProfileId ? 3 : 2;
        notice('已切换，请重启 Codex。');
      });
    }, needsSync ? '同步' : p.active ? '当前' : '切换', 'switch-button' + (p.active && !needsSync ? '' : ' primary'));
    switcher.disabled = p.active && !needsSync;
    const test = button('plug-zap', '测试连接 ' + p.name, () => testProfile(p));
    test.disabled = !p.hasKey;
    test.hidden = !window.codexManager;
    actions.append(switcher, test, button('pencil', '编辑 ' + p.name, () => openEditor(p)), button('trash-2', '删除 ' + p.name, () => removeProfile(p)));
    article.append(info, actions, renderUsage(p)); group.list.append(article);
    if (p.connectionTest) {
      const t = p.connectionTest;
      const result = el('div', 'connection-result' + (t.status === 'error' ? ' failed' : ''));
      result.setAttribute('role', 'status');
      result.title = '测试时间：' + new Date(t.checkedAt).toLocaleString('zh-CN');
      result.append(icon(t.status === 'ok' ? 'circle-check' : 'circle-alert'), el('strong', '', t.message),
        el('span', '', `${t.httpStatus ? `HTTP ${t.httpStatus} · ` : ''}${milliseconds(t.durationMs)}`));
      if (t.status === 'error') result.append(el('p', '', t.hint));
      article.append(result);
    }
  }
  if (!state.profiles.length) {
    const empty = el('div', 'empty-state');
    empty.append(icon('layers'), el('p', '', '暂无 API'));
    $('profiles').append(empty);
  }
  icons();
}
function milliseconds(value) { return value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`; }
function renderMetrics(m) {
  if (!m) return;
  $('monitor-toggle').checked = m.enabled;
  $('monitor-toggle').disabled = busy;
  const hasData = m.enabled || m.active || m.success || m.failed;
  $('monitor-body').hidden = !hasData;
  $('monitor-stats').replaceChildren(
    metric('本机并发', hasData ? String(m.active) : '—'),
    metric('并发峰值', hasData ? String(m.peak) : '—'),
    metric('请求 / 分钟', hasData ? String(m.rpm) : '—'),
    metric('成功 / 失败', hasData ? `${m.success} / ${m.failed}` : '—'),
    metric('429 限流', hasData ? String(m.limited) : '—'),
    metric('平均首字节', milliseconds(m.firstByte)),
  );
  $('request-count').textContent = m.recent.length;
  $('request-rows').replaceChildren();
  for (const r of m.recent) {
    const tr = el('tr');
    tr.append(el('td', 'mono', new Date(r.startedAt).toLocaleTimeString('zh-CN')));
    const provider = el('td'); provider.append(el('span', '', r.provider), el('small', 'request-model', r.model)); tr.append(provider);
    const statusText = r.endedAt ? r.label === 'cancelled' ? '已取消' : `HTTP ${r.status}` : '进行中';
    const sourceNames = { upstream: '上游返回', transport: '上游连接失败', local: '本机转发失败' };
    tr.append(el('td', r.endedAt ? r.status < 300 ? 'request-ok' : 'request-error' : 'request-pending', statusText + (r.failureSource ? ` · ${sourceNames[r.failureSource] || ''}` : '')));
    tr.append(el('td', '', milliseconds(r.firstByte)), el('td', '', milliseconds(r.duration))); $('request-rows').append(tr);
  }
  if (!m.recent.length) { const tr = el('tr'); const td = el('td', 'usage-message', '暂无请求'); td.colSpan = 5; tr.append(td); $('request-rows').append(tr); }
  for (const node of document.querySelectorAll('[data-provider-count]')) {
    const stats = m.provider[node.dataset.providerCount];
    node.textContent = hasData ? `并发 ${stats?.active || 0}` : '';
  }
  if (m.recoveryWarning) notice(m.recoveryWarning, true);
}
async function openEditor(p) {
  const generation = ++editorGeneration; editorKeyChanged = false;
  editingId = p?.id || null; const form = $('profile-form'); form.reset(); $('profile-options').open = false;
  $('editor-title').textContent = p ? '编辑 API' : '添加 API';
  for (const key of ['name', 'url', 'model', 'effort', 'adapter']) if (p) form.elements[key].value = p[key];
  form.elements.key.type = 'password'; form.elements.key.value = ''; form.elements.key.placeholder = p?.hasKey ? '读取中...' : '填写 Key';
  const submit = form.querySelector('[type="submit"]');
  form.elements.key.disabled = $('toggle-key').disabled = submit.disabled = !!p?.hasKey;
  $('editor').showModal(); renderGuide(); icons();
  if (p?.hasKey) {
    try {
      const { result } = await api('read-key', { id: p.id });
      if (generation !== editorGeneration || !$('editor').open) return;
      form.elements.key.value = result.key;
      form.elements.key.placeholder = '留空保留原 Key';
      form.elements.key.disabled = $('toggle-key').disabled = submit.disabled = false;
    } catch (e) {
      if (generation !== editorGeneration || !$('editor').open) return;
      $('editor').close(); notice(e.message, true);
    }
  }
}
async function removeProfile(p) {
  if (p.active) { notice('请先切换到其他 API，再删除当前 API。', true); return; }
  $('delete-name').textContent = p.name; $('delete-dialog').showModal();
  $('delete-dialog').onclose = () => { if ($('delete-dialog').returnValue === 'delete') run(async () => { await api('delete', { id: p.id }); notice('已删除 ' + p.name); }); };
}
function refreshOne(p) {
  run(async () => { notice(`查询 ${p.name}…`); const { result } = await api('refresh', { id: p.id }); notice(result.status === 'ok' ? '用量已更新' : `${p.name}：${result.message}`, result.status === 'error'); });
}
$('add').onclick = () => openEditor();
$('restart-codex').onclick = () => run(async () => {
  const b = $('restart-codex'); b.disabled = true;
  try { const result = await api('restart-codex', {}); if (!result.canceled) { setRestartNeeded(false); if (guideStep === 3) guideStep = 4; notice('Codex 已重新打开。'); } }
  finally { b.disabled = false; }
});
$('restart-now').onclick = () => $('restart-codex').click();
$('restart-later').onclick = $('close-restart-reminder').onclick = () => { restartDismissed = true; renderRestartReminder(); };
async function testProfile(p) {
  await run(async () => {
    const response = await api('test-connection', { id: p.id });
    if (response.canceled) return;
    notice(`${p.name}：${response.result.message}`, response.result.status === 'error');
  });
}
$('export-diagnostics').onclick = async () => {
  if (busy) return;
  const button = $('export-diagnostics'); button.disabled = true;
  try { const result = await api('export-diagnostics', {}); if (!result.canceled) settingsNotice('诊断信息已导出，可发给朋友协助排查。'); }
  catch (error) { settingsNotice(error.message, true); }
  finally { button.disabled = false; }
};
$('close-editor').onclick = $('cancel-editor').onclick = () => { $('profile-form').elements.key.value = ''; $('editor').close(); };
$('editor').addEventListener('close', () => { editorGeneration++; editorKeyChanged = false; $('profile-form').elements.key.value = ''; renderGuide(); });
$('profile-form').elements.key.addEventListener('input', () => { editorKeyChanged = true; });
$('toggle-key').onclick = () => { const input = $('profile-form').elements.key; input.type = input.type === 'password' ? 'text' : 'password'; };
$('profile-form').onsubmit = e => {
  e.preventDefault(); if (busy || e.target.querySelector('[type="submit"]').disabled) return;
  const data = Object.fromEntries(new FormData(e.target)); data.id = editingId;
  if (editingId && !editorKeyChanged) data.key = '';
  run(async () => {
    const beforeIds = new Set(state.profiles.map(p => p.id));
    await api('save', data);
    if (guideStep === 1 && !data.id) {
      state = await api('state');
      const created = state.profiles.find(p => !beforeIds.has(p.id) && p.hasKey);
      if (created) { guideProfileId = created.id; guideStep = 2; }
    }
    $('profile-form').elements.key.value = ''; $('editor').close(); notice('已保存');
  });
};
$('refresh-all').onclick = () => run(async () => {
  const targets = state.profiles.filter(p => p.hasKey && p.adapter !== 'none');
  if (!targets.length) { notice('请先填写 API Key。'); return; }
  $('refresh-all').disabled = true;
  try {
    let errors = 0;
    for (const p of targets) { notice(`正在查询 ${p.name}…`); const { result } = await api('refresh', { id: p.id }); if (result.status === 'error') errors++; await load(); }
    notice(`已刷新 ${targets.length} 个 API${errors ? `，${errors} 个查询失败。` : '。'}`, !!errors);
  } finally { $('refresh-all').disabled = false; }
});
$('import').onclick = () => run(async () => { await api('import', {}); notice('已导入'); });
$('restore').onclick = () => run(async () => {
  const wasPending = restartNeeded;
  await api('restore', {});
  state = await api('state');
  const needsRestart = restartBaseline ? state.current.connectionRevision !== restartBaseline : !wasPending;
  setRestartNeeded(needsRestart);
  notice(needsRestart ? '已撤销，请重启 Codex。' : '已撤销切换。');
});
$('monitor-toggle').onchange = e => {
  const enabled = e.target.checked;
  run(async () => { await api('monitor', { enabled }); markConnectionChange(); notice(enabled ? '监控已开启，请重启 Codex。' : '监控已关闭，请重启 Codex。'); });
};
function settingsNotice(text, error = false) {
  $('settings-notice').textContent = text;
  $('settings-notice').className = 'notice' + (error ? ' error' : '');
  $('settings-notice').hidden = !text;
}
function renderSettings() {
  const s = state.settings;
  $('data-path').value = s.dataDir; $('data-path').title = s.dataDir;
  $('logging-enabled').checked = s.logging;
  $('auto-updates').checked = s.autoUpdates !== false;
  $('retention-days').value = s.retentionDays;
  $('retention-days').disabled = !s.logging;
  $('log-path').textContent = s.logDir;
  $('settings-path').textContent = s.settingsFile;
  $('codex-path').textContent = state.configDir;
  $('cache-path').textContent = state.cacheDir;
  settingsNotice(s.warning || '', !!s.warning);
}
$('settings').onclick = async () => { if (busy || !state.settings) return; try { await load(); renderSettings(); $('storage-details').open = false; $('settings-dialog').showModal(); icons(); } catch (e) { notice(e.message, true); } };
$('close-settings').onclick = $('cancel-settings').onclick = () => $('settings-dialog').close();
for (const b of document.querySelectorAll('[data-open-dir]')) b.onclick = async () => {
  try { await api('open-directory', { kind: b.dataset.openDir }); } catch (e) { settingsNotice(e.message, true); }
};
$('clear-logs').onclick = async () => {
  try { const result = await api('clear-logs', {}); if (result.cleared) settingsNotice('日志已清空'); }
  catch (e) { settingsNotice(e.message, true); }
};
$('logging-enabled').onchange = () => { $('retention-days').disabled = !$('logging-enabled').checked; };
$('settings-form').onsubmit = async e => {
  e.preventDefault(); if (busy) return;
  busy = true; $('settings-form').setAttribute('aria-busy', 'true');
  try {
    await api('settings', { dataDir: $('data-path').value, logging: $('logging-enabled').checked, retentionDays: Number($('retention-days').value), autoUpdates: $('auto-updates').checked });
    await load(); renderSettings();
    settingsNotice('已保存');
  } catch (e) { settingsNotice(e.message, true); }
  finally { busy = false; $('settings-form').removeAttribute('aria-busy'); }
};
function transferNotice(text) { $('transfer-notice').textContent = text; $('transfer-notice').hidden = !text; }
function selectedTransfer() { return [...document.querySelectorAll('#transfer-list input:checked')].map(input => input.dataset.id); }
function updateTransferSelection() {
  const total = $('transfer-list').children.length, selected = selectedTransfer().length;
  const selectable = document.querySelectorAll('#transfer-list input:not(:disabled)').length;
  $('transfer-all').checked = !!selectable && selected === selectable;
  $('transfer-all').indeterminate = selected > 0 && selected < selectable;
  $('transfer-count').textContent = `${selected} / ${total}`;
  $('submit-transfer').disabled = !selected;
  $('transfer-command').textContent = `${transferMode === 'import' ? '导入' : '导出'} ${selected}`;
  $('export-key-warning').hidden = transferMode !== 'export';
}
function openTransfer(mode, profiles, preview) {
  transferMode = mode; transferPreview = preview;
  $('transfer-title').textContent = mode === 'import' ? '导入 API' : '导出 API';
  $('import-source').hidden = mode !== 'import';
  $('import-file-name').textContent = preview?.fileName || '';
  $('import-duplicates').hidden = mode !== 'import'; $('duplicate-mode').value = 'skip';
  $('transfer-list').replaceChildren(); transferNotice('');
  for (const p of profiles) {
    const row = el('label', 'transfer-row');
    const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.disabled = mode === 'export' && !p.hasKey; checkbox.checked = !checkbox.disabled; checkbox.dataset.id = mode === 'import' ? p.index : p.id;
    checkbox.onchange = updateTransferSelection;
    const info = el('span', 'transfer-info'), name = el('span', 'transfer-name'); name.append(el('strong', '', p.name));
    if (mode === 'import') {
      if (p.duplicate) name.append(el('span', 'badge empty', '重复'));
    }
    if (checkbox.disabled) name.append(el('span', 'badge empty', '未填写 Key'));
    info.append(name, el('span', 'mono transfer-url', p.url)); row.append(checkbox, info); $('transfer-list').append(row);
  }
  $('submit-transfer').replaceChildren(icon(mode === 'import' ? 'folder-input' : 'folder-output'), el('span', '', ''));
  $('submit-transfer').lastElementChild.id = 'transfer-command';
  updateTransferSelection();
  if (!$('transfer-dialog').open) $('transfer-dialog').showModal();
  icons();
}
async function chooseImport() {
  if (busy) return;
  busy = true;
  try {
    const result = await api('preview-import', {});
    if (result.canceled) { if (transferMode === 'import' && $('transfer-dialog').open) $('transfer-dialog').close(); return; }
    openTransfer('import', result.preview.profiles, result.preview);
  } catch (e) {
    if ($('transfer-dialog').open) { transferPreview = null; $('submit-transfer').disabled = true; transferNotice(e.message); }
    else notice(e.message, true);
  } finally { busy = false; }
}
$('import-file').onclick = $('choose-import-file').onclick = chooseImport;
$('export-file').onclick = async () => {
  if (busy) return;
  try { await load(); if (state.profiles.length) openTransfer('export', state.profiles); }
  catch (e) { notice(e.message, true); }
};
$('close-transfer').onclick = $('cancel-transfer').onclick = () => { if (!busy) $('transfer-dialog').close(); };
$('transfer-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('transfer-dialog').addEventListener('close', () => {
  transferPreview = null;
  if (window.codexManager) api('discard-import', {}).catch(() => {});
});
$('transfer-all').onchange = event => { for (const input of document.querySelectorAll('#transfer-list input:not(:disabled)')) input.checked = event.target.checked; updateTransferSelection(); };
$('transfer-form').onsubmit = async event => {
  event.preventDefault(); if (busy || !selectedTransfer().length) return;
  busy = true; $('transfer-form').setAttribute('aria-busy', 'true'); transferNotice('');
  try {
    const selected = selectedTransfer();
    const response = transferMode === 'export'
      ? await api('export-profiles', { ids: selected })
      : await api('apply-import', { token: transferPreview?.token, indices: selected.map(Number), duplicates: $('duplicate-mode').value });
    if (response.canceled) return;
    $('transfer-dialog').close(); await load();
    const result = response.result;
    notice(transferMode === 'export' ? `已导出 ${result.count} 个 API` : `已导入 ${result.added + result.updated} 个 API${result.skipped ? `，跳过 ${result.skipped} 个` : ''}`);
  } catch (e) { transferNotice(e.message); }
  finally { busy = false; $('transfer-form').removeAttribute('aria-busy'); }
};
setInterval(async () => {
  if (metricsBusy || !state) return;
  metricsBusy = true;
  try { renderMetrics(await api('metrics')); } catch {} finally { metricsBusy = false; }
}, 1000);
let updateState, updatePollBusy = false;
function renderUpdate(s) {
  updateState = s;
  const updating = ['downloading', 'installing'].includes(s.phase);
  $('update-banner').hidden = !s.latestVersion || !['available', 'downloading', 'installing', 'error'].includes(s.phase);
  $('update-title').textContent = `新版本 ${s.latestVersion || ''}`;
  const status = s.phase === 'downloading' ? `正在下载 ${s.progress}%` : s.phase === 'installing' ? '等待请求结束，更新并重新打开…'
    : s.phase === 'checking' ? '正在检查…' : s.phase === 'latest' ? '已是最新版本' : s.phase === 'error' ? s.message
    : s.latestVersion ? `可更新到 ${s.latestVersion}` : '检查 GitHub 发布版本';
  $('update-detail').textContent = updating || s.phase === 'error' ? status : '保留配置，更新并重新打开。';
  $('update-version').textContent = `当前版本 ${s.currentVersion}`;
  $('update-status-text').textContent = status;
  $('install-update').disabled = updating || !s.canInstall;
  $('install-update').querySelector('span').textContent = updating ? s.phase === 'downloading' ? `${s.progress}%` : '更新中' : '更新并重启';
  $('check-update').disabled = updating || s.phase === 'checking';
}
$('check-update').onclick = async () => {
  if (!window.codexManager) return;
  $('check-update').disabled = true;
  try { renderUpdate(await api('check-update')); } catch { $('update-status-text').textContent = '检查失败，请稍后重试。'; }
  finally { if (updateState) renderUpdate(updateState); }
};
$('install-update').onclick = async () => {
  if (busy || !updateState?.canInstall) return;
  busy = true;
  try { await api('install-update', {}); } catch (error) { notice(error.message, true); }
  finally { busy = false; pollUpdate(); }
};
async function pollUpdate() {
  if (!window.codexManager || updatePollBusy) return;
  updatePollBusy = true;
  try { renderUpdate(await api('update-status')); } catch {} finally { updatePollBusy = false; }
}
if (window.codexManager) { pollUpdate(); setInterval(pollUpdate, 1000); }
else { $('check-update').closest('.update-control').hidden = true; $('auto-updates').closest('label').hidden = true; }
icons(); load().catch(e => notice(e.message, true));
