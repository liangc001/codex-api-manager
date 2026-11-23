(() => {
  if (!window.codexManager) return;
  const workspace = $('vpn-workspace'), details = $('vpn-details'), more = $('vpn-more');
  const region = $('vpn-region'), mode = $('vpn-mode');
  const labels = { disconnected: '未连接', connecting: '正在连接', switching: '正在切换', connected: '已连接', recovering: '正在恢复',
    external: '系统代理已被接管', modified: '绕行规则已改变', disconnecting: '正在断开', error: '连接异常',
    checking: '正在检测线路', updating: '正在更新订阅', importing: '正在导入配置' };
  const operations = { import: '正在导入…', connect: '正在连接', disconnect: '正在断开', 'open-codex': '正在打开 Codex',
    'check-sources': '正在检测线路', 'update-researchlab': '正在更新订阅', 'import-clash': '正在导入 Clash', 'import-v2ray': '正在导入 v2rayN' };
  const sources = { racknerd: 'RackNerd', researchlab: 'ResearchLab', clash: 'Clash' };
  const display = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'code' });
  let state, pending, statusUnavailable = false, notice = '', actionError = '', preferredLoaded = false, lastMode;
  function message(id, text) {
    if ($(id).textContent !== text) $(id).textContent = text;
    $(id).hidden = !text;
  }
  function feedback() {
    const error = actionError || (statusUnavailable ? '无法读取 VPN 状态。' : state?.error || '');
    message('vpn-error', error);
    $('vpn-feedback').hidden = $('vpn-error').hidden;
    $('vpn-retry-status').hidden = !statusUnavailable;
    message('vpn-settings-message', error || notice || state?.notice || (!state?.imported ? '未导入 VPN 配置' : state.stopped ? 'VPN 服务已停止' : ''));
    $('vpn-settings-message').classList.toggle('error', !!error);
  }
  const regionName = code => /^[A-Z]{2}$/.test(code || '') ? display.of(code) : '自动选择';
  function render(status) {
    state = status;
    const configured = !!status.imported, busy = !!status.busy, dormant = !!status.dormant;
    const connected = !!(status.connected || status.proxyPort), ready = configured && !dormant;
    const retry = ['external', 'modified', 'error'].includes(status.phase) || status.healthy === false;
    const operationPending = !!status.operation;
    $('vpn-setup').hidden = configured;
    $('vpn-import').disabled = busy;
    $('vpn-controls').hidden = !configured;
    $('vpn-preferences').hidden = !configured;
    $('vpn-preferences').inert = statusUnavailable;
    more.hidden = !configured;
    if (!configured) setExpanded(false);
    const phase = statusUnavailable ? '状态未同步' : status.stopped ? '服务已停止' : !configured && !busy ? '未配置' :
      (status.phase === 'switching' ? labels.switching : operations[status.operation]) || labels[status.phase] || '未连接';
    workspace.dataset.tone = statusUnavailable || retry ? 'warning' : busy ? 'busy' : connected ? 'online' : 'idle';
    const indicator = $('vpn-status');
    if (indicator.textContent !== phase) indicator.textContent = phase;
    feedback();
    message('vpn-notice', notice || status.notice || '');
    if (!configured) return;

    const preferred = status.requestedRegion || status.preferredRegion || 'auto';
    const options = status.regions?.length ? status.regions : [{ code: preferred, label: regionName(preferred) }];
    const values = JSON.stringify(options);
    if (region.dataset.values !== values) {
      const value = !preferredLoaded ? preferred : region.value;
      region.replaceChildren(...options.map(item => new Option(item.label, item.code)));
      region.value = options.some(item => item.code === value) ? value : options.some(item => item.code === preferred) ? preferred : options[0].code;
      region.dataset.values = values;
    }
    preferredLoaded ||= ready;
    $('vpn-load-regions').hidden = !dormant;
    $('vpn-load-regions').querySelector('span').textContent = regionName(preferred);
    $('vpn-load-regions').disabled = statusUnavailable;
    region.hidden = dormant;
    region.disabled = busy || statusUnavailable;
    if (connected || (busy && ['connect', 'open-codex'].includes(status.operation))) mode.value = status.mode || 'app';
    else if (lastMode !== status.preferredMode && status.preferredMode) mode.value = status.preferredMode;
    lastMode = status.preferredMode;
    mode.disabled = connected || busy || statusUnavailable;
    message('vpn-scope', statusUnavailable ? '' : mode.value === 'system' ? '系统代理' : '应用代理');
    const sameRegion = status.requestedRegion === region.value;
    $('vpn-connect').querySelector('span').textContent = !connected ? '连接' : retry ? status.phase === 'external' || status.phase === 'modified' ? '重新接管' : '重新连接' : sameRegion ? '重新连接' : '切换地区';
    $('vpn-connect').disabled = busy || statusUnavailable;
    $('vpn-disconnect').hidden = statusUnavailable || (!connected && !status.error && status.phase !== 'recovering');
    $('vpn-disconnect').disabled = operationPending && status.operation !== 'connect';
    $('vpn-cancel-connect').hidden = statusUnavailable || (!['connect', 'open-codex'].includes(status.operation) && !['connecting', 'switching', 'recovering'].includes(status.phase));
    $('vpn-refresh-latency').disabled = statusUnavailable || !connected || busy || !!status.checkingLatency;
    $('vpn-refresh-latency').classList.toggle('is-checking', !statusUnavailable && !!status.checkingLatency);
    const showReadings = !statusUnavailable && connected;
    $('vpn-health').textContent = !showReadings || status.healthy == null ? '—' : status.healthy ? '已连通' : '未测通';
    $('vpn-exit-country').textContent = showReadings && status.country ? regionName(status.country) : '—';
    message('vpn-exit-ip', showReadings ? status.exitIp || '' : '');
    $('vpn-latency').textContent = !showReadings ? '—' : status.checkingLatency ? '检测中' : status.latencyMs != null ? status.latencyMs + ' ms' : status.healthy === false ? '未测通' : '—';
    $('vpn-latency').title = showReadings && status.latencyAt ? new Date(status.latencyAt).toLocaleString() : '';
    $('vpn-codex').disabled = statusUnavailable || busy;
    details.inert = statusUnavailable;
    $('vpn-agy').disabled = busy && status.operation !== 'agy';
    $('vpn-agy').querySelector('span').textContent = status.agyActive ? '停止代理' : '启动代理';
    $('vpn-agy-status').textContent = status.agyReady ? '已就绪' : status.agyActive ? '正在连接' : '未连接';
    $('vpn-agy-settings').disabled = !status.agyReady;
    $('vpn-benchmark').disabled = !!status.rankingBusy || operationPending;
    $('vpn-cancel-benchmark').hidden = !status.rankingBusy;
    $('vpn-check-sources').disabled = busy;
    $('vpn-ranking-status').textContent = status.rankingStatus || '尚未测速';
    $('vpn-auto-recover').checked = status.autoRecover !== false;
    $('vpn-auto-connect').checked = !!status.autoConnect;
    $('vpn-startup').checked = !!status.startWithWindows;
    $('vpn-startup').disabled = !status.canSetStartup;
    $('vpn-update-researchlab').disabled = !status.hasSubscription || busy || !!status.rankingBusy;
    $('vpn-import-v2ray').disabled = $('vpn-import-clash').disabled = connected || busy || !!status.rankingBusy || !!status.agyActive;
    $('vpn-shutdown').disabled = dormant;
    $('vpn-diagnostics').disabled = dormant;
    const probe = [
      status.checkedAt ? '最近检测 ' + new Date(status.checkedAt).toLocaleTimeString() : '',
      status.probeMs != null ? '耗时 ' + (status.probeMs / 1000).toFixed(1) + ' 秒' : '',
      status.campusReachable == null ? '' : '校园网 ' + (status.campusReachable ? '可达' : '暂不可达')
    ].filter(Boolean);
    message('vpn-probe', probe.join(' · '));
    const history = (status.history || []).slice(-12).reverse();
    $('vpn-history-empty').hidden = history.length > 0;
    fillList('vpn-history', history, row => {
      const labelsByAction = { ...operations, latency: '刷新延迟', agy: '启动 agy', 'disconnect-agy': '停止 agy' };
      const result = { started: '开始', completed: '完成', 'not-completed': '未完成' };
      const line = el('li');
      line.append(el('span', '', row.action === 'phase' ? labels[row.result] || '状态变化' : (labelsByAction[row.action] || 'VPN 操作') + ' · ' + result[row.result]),
        el('time', 'mono', new Date(row.at).toLocaleTimeString()));
      return line;
    });
    const ranking = status.rankings || [];
    $('vpn-ranking-empty').hidden = ranking.length > 0 || !!status.rankingBusy;
    fillList('vpn-ranking-list', ranking, row => {
      const li = el('li');
      li.append(el('span', '', row.country), el('span', 'mono', row.milliseconds == null ? row.status : row.milliseconds + ' ms'));
      return li;
    });
    fillList('vpn-sources', status.sources || Object.keys(sources).map(id => ({ id, status: '未检测' })), row => {
      const item = el('div');
      item.append(el('dt', '', sources[row.id] || row.id), el('dd', '', row.status));
      return item;
    });
  }
  function fillList(id, rows, build) {
    const list = $(id), key = JSON.stringify(rows);
    if (list.dataset.values === key) return;
    list.replaceChildren(...rows.map(build));
    list.dataset.values = key;
  }
  function setExpanded(expanded) {
    details.hidden = !expanded;
    more.setAttribute('aria-expanded', String(expanded));
  }
  async function request(op, data) {
    const passive = op === 'overview';
    if (pending) {
      if (passive || pending.op !== 'overview') return;
      await pending.done;
      return request(op, data);
    }
    let finish;
    pending = { op, done: new Promise(resolve => { finish = resolve; }) };
    if (!passive || statusUnavailable) actionError = '';
    if (!passive) notice = '';
    try {
      const response = await api('vpn-' + op, data);
      if (response.canceled) { if (state) render(state); return; }
      if (op === 'diagnostics' || op === 'agy-settings') {
        notice = op === 'diagnostics' ? '已复制脱敏诊断' : '已复制 PowerShell 代理命令';
        render(state);
      } else {
        statusUnavailable = false;
        render(response.result);
      }
    } catch (e) {
      actionError = e.message;
      if (passive) statusUnavailable = true;
      if (state) render(state);
      else {
        $('vpn-status').textContent = '状态未同步';
        workspace.dataset.tone = 'warning';
        feedback();
      }
    } finally { pending = null; finish(); }
  }
  workspace.hidden = false;
  $('settings-tab-vpn').hidden = false;
  $('settings-dialog').addEventListener('settings-tab-change', event => {
    if (event.detail === 'vpn' && state?.imported && state.dormant && !state.stopped) request('status');
  });
  more.onclick = () => {
    setExpanded(details.hidden);
    if (!details.hidden && state?.dormant) request('status');
  };
  region.onchange = () => { if (state) render(state); };
  mode.onchange = () => { if (state) render(state); };
  $('vpn-retry-status').onclick = () => request('overview');
  $('vpn-load-regions').onclick = async () => {
    const trigger = $('vpn-load-regions');
    await request('status');
    if (!region.hidden && (document.activeElement === trigger || document.activeElement === document.body)) region.focus();
  };
  const choices = () => ({ region: region.value, mode: mode.value });
  $('vpn-connect').onclick = () => request('connect', choices());
  $('vpn-codex').onclick = () => request('open-codex', choices());
  for (const [id, op] of Object.entries({ import: 'import', disconnect: 'disconnect', 'cancel-connect': 'cancel-connect',
    'refresh-latency': 'latency', benchmark: 'benchmark', 'cancel-benchmark': 'cancel-benchmark',
    'check-sources': 'check-sources', 'update-researchlab': 'update-researchlab',
    'import-v2ray': 'import-v2ray', 'import-clash': 'import-clash', diagnostics: 'diagnostics', shutdown: 'shutdown', 'agy-settings': 'agy-settings' })) {
    $('vpn-' + id).onclick = () => request(op);
  }
  $('vpn-agy').onclick = () => request(state?.agyActive ? 'disconnect-agy' : 'agy');
  for (const [id, key] of [['auto-connect', 'autoConnect'], ['auto-recover', 'autoRecover']]) {
    $('vpn-' + id).onchange = event => request('set-preference', { key, value: event.target.checked });
  }
  $('vpn-startup').onchange = event => request('startup', { value: event.target.checked });
  window.codexManager.onTrayAction(({ action }) => {
    if (action === 'vpn') workspace.scrollIntoView({ block: 'nearest' });
    if (action === 'vpn-startup-failed') {
      actionError = '启动后连接未完成，请检查旧 VPN 是否仍在运行。';
      feedback();
    }
  });
  request('overview');
  setInterval(() => { if (!statusUnavailable) request('overview'); }, 1350);
})();
