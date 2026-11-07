(() => {
  const get = id => document.getElementById(id);
  const dialog = get('session-repair-dialog');
  get('open-session-repair').hidden = !window.codexManager;
  get('auto-session-repair-control').hidden = !window.codexManager;
  let scan, working = false;
  let configuring = false, lastAuto, recordsBusy = false;
  const phases = { off: '未开启', waiting: '等待处理', target: '需要切换入口', monitor: '等待关闭监控', manual: '手动操作中', paused: '已暂缓', attention: '需要恢复', scanning: '检查中', repairing: '处理中', complete: '已完成', idle: '检查完成', error: '处理失败' };
  const when = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无';
  function autoStatus(value) {
    const previous = lastAuto; lastAuto = value;
    if (!configuring) get('auto-session-repair-toggle').checked = value.enabled;
    get('auto-session-repair-status').textContent = value.blockers?.length ? `尚未开始处理 · 还有 ${value.blockers.length} 项条件未满足` : value.message;
    get('auto-session-repair-status').className = ['error', 'attention'].includes(value.phase) ? 'repair-error' : '';
    get('auto-session-repair-control').dataset.phase = value.phase;
    get('auto-repair-phase').textContent = phases[value.phase] || '等待检查';
    get('auto-repair-blockers').replaceChildren();
    for (const text of value.blockers || []) { const li = document.createElement('li'); li.textContent = text; get('auto-repair-blockers').append(li); }
    get('auto-repair-blockers').hidden = !value.blockers?.length;
    get('auto-repair-connection').textContent = value.currentProvider ? `当前入口 ${value.currentProvider} · 兼容目标 ${value.target}` : '';
    get('auto-repair-counts').textContent = value.counts ? `本轮预览：待处理 ${value.counts.eligible} · 跳过 ${value.counts.skipped}${value.counts.truncated ? ' · 还有更早的对话' : ''}` : '尚未扫描对话';
    get('auto-repair-times').textContent = `最近检查：${when(value.checkedAt)}${value.lastRun ? `\n最近处理：${when(value.lastRun.finishedAt)} · ${value.lastRun.count} 个${value.lastRun.undoneAt ? '（已撤回）' : ''}` : '\n尚未处理任何对话'}${value.retryAt ? `\n下次重试：${when(value.retryAt)}` : ''}${value.recordWarning ? '\n' + value.recordWarning : ''}`;
    get('check-auto-session-repair').disabled = !value.enabled || configuring || ['scanning', 'repairing'].includes(value.phase);
    get('auto-repair-overview').hidden = !value.enabled && !value.lastRun;
    get('auto-repair-overview').dataset.phase = value.phase;
    get('auto-repair-overview-text').textContent = value.phase === 'off' ? '自动处理已关闭' : value.message;
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
  get('auto-repair-overview').onclick = async () => { await get('settings').onclick(); selectSettingsTab('support'); await syncAuto(); };
  async function renderRecords() {
    if (recordsBusy) return; recordsBusy = true;
    try {
      const value = await api('auto-session-repair-details');
      get('auto-repair-records-status').textContent = value.message;
      const history = get('auto-repair-records');
      const expanded = new Map([...history.querySelectorAll('details')].map(d => [d.dataset.batch, d.open])); history.replaceChildren();
      if (!value.records.length) { const p = document.createElement('p'); p.className = 'auto-repair-empty'; p.textContent = '尚未处理任何对话。开启开关后仍需满足运行条件。'; history.append(p); }
      for (const batch of value.records) {
        const details = document.createElement('details'); details.className = 'auto-repair-batch'; details.dataset.batch = batch.batchAt; details.open = expanded.get(batch.batchAt) ?? batch === value.records[0];
        const summary = document.createElement('summary'); summary.textContent = `${when(batch.finishedAt)} · ${batch.mode === 'manual' ? '手动修复' : batch.mode === 'recovered' ? '从备份恢复的记录' : '自动兼容'} ${batch.count} 个${batch.undoneAt ? ' · 已撤回' : ' · 已完成'}`;
        details.append(summary);
        details.append(recordRow('处理时间', `${when(batch.batchAt)} → ${when(batch.finishedAt)}`));
        for (const entry of batch.entries) details.append(recordRow(entry.title, `${entry.source} → ${entry.target}`));
        if (batch.undoneAt) details.append(recordRow('撤回时间', when(batch.undoneAt)));
        history.append(details);
      }
      const pending = get('auto-repair-pending'); pending.replaceChildren();
      const title = document.createElement('h3'); title.textContent = '本轮检查'; pending.append(title);
      if (!value.entries.length) {
        const p = document.createElement('p'); p.className = 'auto-repair-empty'; p.textContent = value.counts ? '本轮没有待处理或跳过的对话。' : '尚未扫描。先在设置中检查运行条件。'; pending.append(p);
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
  get('open-auto-repair-records').onclick = () => { get('auto-repair-records-dialog').showModal(); renderRecords(); };
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
    get('apply-session-repair').disabled = working || !count || count > 100 || scan?.pending;
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
      if (!scan.entries.length) { const empty = document.createElement('p'); empty.textContent = '没有需要迁移到当前 provider 的对话。'; get('session-repair-list').append(empty); }
      status(scan.pending ? '上次修复未完成，请先点击「撤回上次修复」恢复。' : message || (scan.truncated ? '仅显示最近 3000 条记录，每次最多修复 100 个对话。' : '请选择要修复的对话，每次最多 100 个。'));
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
