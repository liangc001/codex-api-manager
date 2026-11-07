(() => {
  const get = id => document.getElementById(id);
  const dialog = get('session-repair-dialog');
  get('open-session-repair').hidden = !window.codexManager;
  get('auto-session-repair-control').hidden = !window.codexManager;
  get('auto-repair-overview').hidden = !window.codexManager;
  let scan, working = false;
  let configuring = false, lastAuto, recordsBusy = false;
  const phases = { off: '未开启', waiting: '等待处理', target: '需要切换入口', monitor: '等待关闭监控', manual: '手动操作中', paused: '已暂缓', attention: '需要恢复', scanning: '检查中', repairing: '处理中', complete: '已完成', idle: '检查完成', error: '处理失败' };
  const when = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无';
  function node(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
  function timeRow(label, value, extra = '') {
    const row = node('div', 'auto-repair-time-row'); const time = node('time', '', value ? when(value) + extra : '暂无' + extra);
    if (value) time.dateTime = new Date(value).toISOString(); row.append(node('span', '', label), time); return row;
  }
  function autoStatus(value) {
    const previous = lastAuto; lastAuto = value;
    if (!configuring) get('auto-session-repair-toggle').checked = value.enabled;
    get('auto-session-repair-status').textContent = value.blockers?.length ? `尚未开始处理 · 还有 ${value.blockers.length} 项条件未满足` : value.message;
    get('auto-session-repair-status').className = ['error', 'attention'].includes(value.phase) ? 'repair-error' : '';
    get('auto-session-repair-control').dataset.phase = value.phase;
    get('auto-repair-phase').textContent = phases[value.phase] || '等待检查';
    get('auto-repair-blockers').replaceChildren();
    for (const text of value.blockers || []) {
      const concise = text.startsWith('当前连接入口不兼容') ? '在 API 列表点击「同步入口」或「切换」'
        : text.startsWith('Codex 仍在运行') ? text.includes('VS Code') ? '退出 Codex App、CLI 和 VS Code 中的 Codex' : '退出 Codex App、CLI 和编辑器中的 Codex'
        : text.startsWith('请关闭请求监控') ? '关闭请求监控，等待请求结束并完成配置恢复' : text;
      const li = node('li', '', concise); li.title = text; get('auto-repair-blockers').append(li);
    }
    get('auto-repair-blockers').hidden = !value.blockers?.length;
    const connection = get('auto-repair-connection'); connection.replaceChildren(); connection.hidden = !value.currentProvider;
    if (value.currentProvider) {
      connection.append(node('span', 'auto-repair-field-label', '连接入口'), node('code', '', value.currentProvider));
      if (value.currentProvider !== value.target) connection.append(node('span', 'auto-repair-arrow', '→'), node('code', '', value.target));
      else connection.append(node('span', 'auto-repair-aligned', '已统一'));
    }
    const counts = get('auto-repair-counts'); counts.replaceChildren();
    if (value.counts) {
      for (const [label, count] of [['待处理', value.counts.eligible], ['跳过', value.counts.skipped]]) {
        const stat = node('span', 'auto-repair-count'); stat.append(node('span', '', label + ' '), node('strong', '', count)); counts.append(stat);
      }
      if (value.counts.truncated) counts.append(node('span', 'auto-repair-more-count', '还有更早的对话'));
    } else counts.append(node('span', 'auto-repair-unscanned', '尚未扫描对话'));
    const times = get('auto-repair-times'); times.replaceChildren(timeRow('最近检查', value.checkedAt));
    if (value.lastRun) times.append(timeRow('最近处理', value.lastRun.finishedAt, ` · ${value.lastRun.count} 个${value.lastRun.undoneAt ? '（已撤回）' : ''}`));
    else times.append(node('div', 'auto-repair-no-history', '尚未处理任何对话'));
    if (value.retryAt) times.append(timeRow('下次重试', value.retryAt));
    if (value.recordWarning) times.append(node('p', 'repair-error', value.recordWarning));
    get('check-auto-session-repair').disabled = !value.enabled || configuring || ['scanning', 'repairing'].includes(value.phase);
    get('auto-repair-overview').hidden = !window.codexManager;
    get('auto-repair-overview').dataset.phase = value.phase;
    get('auto-repair-overview-text').textContent = value.phase === 'off' ? '开启后，退出 Codex 即可自动处理旧对话' : value.message;
    get('compatibility-overview-phase').textContent = phases[value.phase] || '等待检查';
    get('auto-repair-overview').title = value.message;
    if (value.phase === 'complete' && previous?.phase !== 'complete') notice(value.message + '，可查看处理记录。');
    if (get('auto-repair-records-dialog').open) renderRecords();
  }
  async function syncAuto() { if (window.codexManager) { try { autoStatus(await api('auto-session-repair-status')); } catch {} } }
  get('auto-session-repair-toggle').onchange = async () => {
    configuring = true; get('auto-session-repair-toggle').disabled = true;
    try { autoStatus(await api('auto-session-repair-settings', { enabled: get('auto-session-repair-toggle').checked })); }
    catch (e) { get('auto-session-repair-status').textContent = e.message; }
    finally { configuring = false; get('auto-session-repair-toggle').disabled = false; await syncAuto(); }
  };
  window.codexManager?.onAutoSessionRepair?.(autoStatus);
  syncAuto();
  setInterval(syncAuto, 5000);
  get('check-auto-session-repair').onclick = async () => {
    get('check-auto-session-repair').disabled = true;
    get('auto-session-repair-status').textContent = '正在检查运行条件…';
    try { autoStatus(await api('check-auto-session-repair')); }
    catch (e) { get('auto-session-repair-status').textContent = e.message; }
    finally { await syncAuto(); }
  };
  async function openCompatibility() { if (!get('compatibility-dialog').open) get('compatibility-dialog').showModal(); await syncAuto(); }
  get('open-compatibility').onclick = get('open-compatibility-panel').onclick = openCompatibility;
  get('close-compatibility').onclick = () => get('compatibility-dialog').close();
  async function renderRecords() {
    if (recordsBusy) return; recordsBusy = true;
    try {
      const value = await api('auto-session-repair-details');
      get('auto-repair-records-status').textContent = value.message;
      const history = get('auto-repair-records');
      const expanded = new Map([...history.querySelectorAll('details')].map(d => [d.dataset.batch, d.open])); history.replaceChildren();
      if (!value.records.length) {
        const empty = node('div', 'auto-repair-empty-state'); empty.append(node('strong', '', '还没有处理记录'), node('p', '', '满足运行条件后，处理结果会保存在这里。')); history.append(empty);
      }
      for (const batch of value.records) {
        const details = document.createElement('details'); details.className = 'auto-repair-batch'; details.dataset.batch = batch.batchAt; details.open = expanded.get(batch.batchAt) ?? batch === value.records[0];
        details.dataset.outcome = batch.undoneAt ? 'undone' : 'complete';
        const summary = node('summary'); const label = node('span', 'auto-repair-batch-label');
        label.append(node('strong', '', `${batch.mode === 'manual' ? '手动修复' : batch.mode === 'recovered' ? '备份恢复记录' : '自动兼容'} ${batch.count} 个`), node('time', '', when(batch.finishedAt)));
        const badge = node('span', 'auto-repair-batch-badge', batch.undoneAt ? '已撤回' : '已完成');
        summary.append(node('span', 'auto-repair-batch-mark', batch.undoneAt ? '↶' : '✓'), label, badge);
        details.append(summary);
        details.append(node('p', 'auto-repair-duration', `${when(batch.batchAt)} → ${when(batch.finishedAt)}`));
        for (const entry of batch.entries) details.append(recordRow(entry.title, `${entry.source} → ${entry.target}`));
        if (batch.undoneAt) details.append(recordRow('撤回时间', when(batch.undoneAt)));
        history.append(details);
      }
      const pending = get('auto-repair-pending'); pending.replaceChildren();
      const title = node('h3'); title.append(node('span', '', '本轮检查'), node('small', '', value.counts ? `${value.counts.eligible} 待处理 · ${value.counts.skipped} 已跳过` : '尚未扫描')); pending.append(title);
      if (!value.entries.length) {
        const p = document.createElement('p'); p.className = 'auto-repair-empty'; p.textContent = value.counts ? '本轮没有待处理或跳过的对话。' : '尚未扫描。请在旧对话兼容面板中检查运行条件。'; pending.append(p);
      }
      for (const entry of value.entries) pending.append(recordRow(entry.title, entry.eligible ? `待处理 · ${entry.provider} → ${value.target}` : `已跳过 · ${entry.reason}`));
      if (value.entryCount > value.entries.length) pending.append(recordRow('仅显示前 200 条', '其余会话将继续分批检查'));
    } catch (e) { get('auto-repair-records-status').textContent = e.message; }
    finally { recordsBusy = false; }
  }
  function recordRow(title, detail) {
    const row = document.createElement('div'); row.className = 'auto-repair-record';
    const strong = document.createElement('strong'); strong.textContent = title;
    const small = document.createElement('span'); small.textContent = detail; row.append(strong, small); return row;
  }
  get('open-auto-repair-records').onclick = get('open-overview-records').onclick = () => { get('auto-repair-records-dialog').showModal(); renderRecords(); };
  get('close-auto-repair-records').onclick = () => get('auto-repair-records-dialog').close();
  const selected = () => [...get('session-repair-list').querySelectorAll('input:checked:not(:disabled)')].map(input => input.value);
  const status = (message, error = false) => { get('session-repair-notice').textContent = message; get('session-repair-notice').className = error ? 'repair-error' : ''; };
  function controls() {
    const inputs = [...get('session-repair-list').querySelectorAll('input:not(:disabled)')];
    const count = selected().length;
    get('session-repair-count').textContent = count ? `已选 ${count} 个` : '未选择对话';
    get('session-repair-all').checked = !!inputs.length && inputs.length === count;
    get('session-repair-all').indeterminate = count > 0 && count < inputs.length;
    for (const id of ['close-session-repair', 'rescan-session-repair', 'undo-session-repair', 'session-repair-all']) get(id).disabled = working;
    for (const button of get('session-repair-list').querySelectorAll('.repair-exclude')) button.disabled = working;
    get('undo-session-repair').disabled = working || (scan !== null && scan !== undefined && !scan.undo);
    get('session-repair-all').disabled = working || !inputs.length || scan?.pending;
    get('apply-session-repair').disabled = working || !count || count > 100 || scan?.pending || scan?.requiresProviderSync;
    dialog.setAttribute('aria-busy', String(working));
  }
  async function refresh(message) {
    scan = null; working = true; controls(); status('正在扫描本机会话…');
    get('session-repair-list').replaceChildren();
    try {
      scan = (await api('scan-session-repair')).result;
      get('session-repair-target').textContent = scan.target;
      for (const item of scan.entries) {
        const row = document.createElement('div'); row.className = 'repair-session' + (item.eligible ? '' : ' unavailable');
        const input = document.createElement('input'); input.type = 'checkbox'; input.id = 'repair-select-' + item.id; input.value = item.id; input.disabled = !item.eligible || scan.pending; input.onchange = controls;
        const content = document.createElement('label'); content.className = 'repair-session-content'; content.htmlFor = input.id; const title = document.createElement('strong'); title.textContent = item.title;
        const meta = document.createElement('small'); meta.textContent = item.provider + (item.reason ? ' · ' + item.reason : ' → ' + scan.target);
        content.append(title, meta); row.append(input, content);
        if (item.eligible) {
          const exclude = document.createElement('button'); exclude.type = 'button'; exclude.className = 'repair-exclude';
          function label() { const excluded = scan.exclusions.includes(item.id); exclude.textContent = excluded ? '已排除自动兼容' : '保留独立连接'; exclude.setAttribute('aria-pressed', String(excluded)); exclude.setAttribute('aria-label', (excluded ? '取消排除 ' : '保留独立连接 ') + item.title); }
          label();
          exclude.onclick = async event => {
            event.preventDefault(); event.stopPropagation(); if (working) return;
            working = true; controls();
            try { const value = await api('exclude-session-repair', { id: item.id, excluded: !scan.exclusions.includes(item.id) }); scan.exclusions = value.exclusions; autoStatus(value); label(); }
            catch (e) { status(e.message, true); }
            finally { working = false; controls(); }
          };
          row.append(exclude);
        }
        get('session-repair-list').append(row);
      }
      if (!scan.entries.length) { const empty = document.createElement('p'); empty.textContent = '没有需要迁移到 codex_api_manager 的对话。'; get('session-repair-list').append(empty); }
      status(scan.pending ? '上次修复未完成，请先点击「撤回上次修复」恢复。' : scan.requiresProviderSync ? '已扫描；请先在 API 列表点击「同步入口」或「切换」，再重新扫描修复。' : message || (scan.truncated ? '仅显示最近 3000 条记录，每次最多修复 100 个对话。' : '请选择要修复的对话，每次最多 100 个。'));
    } catch (e) { status(message ? message + ' ' + e.message : e.message, true); }
    finally { working = false; controls(); lucide.createIcons(); }
  }
  get('open-session-repair').onclick = () => { dialog.showModal(); refresh(); };
  get('close-session-repair').onclick = () => { if (!working) dialog.close(); };
  dialog.addEventListener('cancel', e => { if (working) e.preventDefault(); });
  dialog.addEventListener('close', () => { api('release-session-repair').catch(() => {}); syncAuto(); });
  get('rescan-session-repair').onclick = () => refresh();
  get('session-repair-all').onchange = () => { for (const input of get('session-repair-list').querySelectorAll('input:not(:disabled)')) input.checked = get('session-repair-all').checked; controls(); };
  async function execute(route, data) {
    if (working) return;
    working = true; controls(); status('正在处理，请勿打开 Codex…');
    try {
      const result = (await api(route, data)).result;
      await syncAuto();
      await refresh(route === 'apply-session-repair' ? `已修复 ${result.count} 个对话，可以重新打开 Codex。` : `已撤回 ${result.count} 个对话的修复。`);
    } catch (e) { status(e.message, true); }
    finally { working = false; controls(); }
  }
  get('apply-session-repair').onclick = () => execute('apply-session-repair', { token: scan?.token, ids: selected() });
  get('undo-session-repair').onclick = () => execute('undo-session-repair');
})();
