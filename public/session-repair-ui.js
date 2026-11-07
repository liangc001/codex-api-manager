(() => {
  const get = id => document.getElementById(id);
  const dialog = get('session-repair-dialog');
  get('open-session-repair').hidden = !window.codexManager;
  get('auto-session-repair-control').hidden = !window.codexManager;
  let scan, working = false;
  let configuring = false;
  function autoStatus(value) {
    if (!configuring) get('auto-session-repair-toggle').checked = value.enabled;
    get('auto-session-repair-status').textContent = value.message;
    get('auto-session-repair-status').className = ['error', 'attention'].includes(value.phase) ? 'repair-error' : '';
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
  setInterval(syncAuto, 15000);
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
