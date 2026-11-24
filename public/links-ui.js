(() => {
  const dialog = $('links-dialog');
  let links = [], groups = [], category = 'all', managing = false, pending = false, removed = null;
  const markers = { chatgpt: 'G', gemini: 'G', claude: 'C', deepseek: 'D', aistudio: 'AI', notebooklm: 'N', linuxdo: 'L', github: 'GH', huggingface: 'HF', v2ex: 'V', deepl: 'D', excalidraw: 'E', ilovepdf: 'PDF', regex101: '.*', jsoncrack: '{}' };
  const message = (text, error = false) => { $('links-message').textContent = text; $('links-message').classList.toggle('is-error', error); };
  async function request(route, data) {
    const value = await api(route, data);
    return value.result || value;
  }
  function openLink(anchor, link) {
    anchor.href = link.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.title = link.url;
    anchor.onclick = event => {
      if (!window.codexManager) return;
      event.preventDefault();
      act(async () => { await request('links-open', { id: link.id }); message('已在浏览器中打开'); });
    };
  }
  function renderQuickLinks() {
    const target = $('quick-links-list'); target.replaceChildren();
    const pinned = links.filter(link => link.pinned);
    for (const link of pinned) {
      const anchor = el('a', 'quick-link');
      const mark = el('span', 'quick-link-mark', markers[link.id] || Array.from(link.name)[0].toLocaleUpperCase()); mark.setAttribute('aria-hidden', 'true');
      anchor.append(mark, document.createTextNode(link.name)); openLink(anchor, link); target.append(anchor);
    }
    if (!pinned.length) target.append(el('span', 'quick-links-empty', '从全部链接中点亮星标即可添加'));
  }
  async function loadLinks() {
    const result = await request('links'); links = result.links; groups = result.groups; renderQuickLinks();
  }
  async function act(action) {
    if (pending) return;
    pending = true; dialog.setAttribute('aria-busy', 'true');
    for (const node of dialog.querySelectorAll('button:not(#close-links), input, select')) node.disabled = true;
    try { await action(); }
    catch (error) { message(error.message, true); if (!dialog.open) notice(error.message, true); }
    finally {
      pending = false; dialog.removeAttribute('aria-busy');
      for (const node of dialog.querySelectorAll('button, input, select')) node.disabled = false;
      const focus = dialog.dataset.nextFocus; delete dialog.dataset.nextFocus;
      if (dialog.open && focus) $(focus).focus();
    }
  }
  function edit(link = null) {
    $('links-form').hidden = false;
    $('links-form-title').textContent = link ? '编辑链接' : '添加链接';
    $('link-id').value = link?.id || '';
    $('link-name').value = link?.name || '';
    $('link-url').value = link?.url || '';
    $('link-group').replaceChildren(...groups.map(group => { const option = el('option', '', group.name); option.value = group.id; return option; }));
    $('link-group').value = link?.group || (category === 'all' ? 'tools' : category);
    $('link-name').focus();
    dialog.querySelector('.links-scroll').scrollTo({ top: 0 });
    $('links-form').scrollIntoView({ block: 'nearest' });
  }
  function refresh() {
    renderQuickLinks();
    const categories = $('links-categories'); categories.replaceChildren();
    for (const group of [{ id: 'all', name: '全部' }, ...groups]) {
      const tab = el('button', '', group.name); tab.type = 'button';
      tab.setAttribute('aria-pressed', String(category === group.id));
      tab.onclick = () => { category = group.id; refresh(); categories.querySelector('[aria-pressed="true"]').focus(); };
      categories.append(tab);
    }
    $('links-manage').setAttribute('aria-pressed', String(managing));
    $('links-manage').textContent = managing ? '完成' : '管理';
    const query = $('links-search').value.trim().toLocaleLowerCase();
    const visible = links.filter(link => (category === 'all' || link.group === category) &&
      [link.name, link.note, new URL(link.url).hostname].join(' ').toLocaleLowerCase().includes(query));
    const content = $('links-content'); content.replaceChildren();
    for (const group of groups) {
      const rows = visible.filter(link => link.group === group.id);
      if (!rows.length) continue;
      const section = el('section', 'links-section'); section.dataset.group = group.id;
      const heading = el('h3', 'links-section-heading'); heading.append(icon(group.icon), document.createTextNode(group.name), el('span', '', String(rows.length)));
      const grid = el('div', 'links-grid');
      for (const link of rows) {
        const card = el('article', 'link-card'); card.dataset.id = link.id;
        const anchor = el('a', 'link-open'); openLink(anchor, link);
        const mark = el('span', 'link-mark', markers[link.id] || Array.from(link.name)[0].toLocaleUpperCase()); mark.setAttribute('aria-hidden', 'true');
        const copy = el('span', 'link-copy'); copy.append(el('strong', '', link.name), el('small', '', link.note || new URL(link.url).hostname));
        anchor.append(mark, copy);
        card.append(anchor);
        const pin = button('star', (link.pinned ? '从首页取消 ' : '固定到首页 ') + link.name, () => act(async () => {
          const result = await request('links-pin', { id: link.id, pinned: !link.pinned });
          links = result.links; refresh(); dialog.dataset.nextFocus = 'link-pin-' + link.id;
          message(link.pinned ? '已从首页取消' : '已固定到首页');
        }), null, 'link-pin icon');
        pin.id = 'link-pin-' + link.id; pin.setAttribute('aria-pressed', String(link.pinned));
        card.append(pin);
        if (managing) {
          const actions = el('div', 'link-edit-actions');
          actions.append(button('pencil', '编辑 ' + link.name, () => edit(link)), button('x', '移除 ' + link.name, () => act(async () => {
            const result = await request('links-delete', { id: link.id });
            links = result.links; removed = link; $('links-undo').hidden = false;
            if ($('link-id').value === link.id) $('links-form').hidden = true;
            message('已移除 ' + link.name); refresh(); dialog.dataset.nextFocus = 'links-undo';
          })));
          card.append(actions);
        }
        grid.append(card);
      }
      section.append(heading, grid); content.append(section);
    }
    $('links-empty').hidden = visible.length !== 0;
    if (!visible.length) $('links-empty').textContent = query ? '没有匹配的链接' : '这里还没有链接';
    window.lucide?.createIcons();
  }
  $('open-links').onclick = () => {
    if (dialog.open) return;
    dialog.showModal();
    dialog.dataset.nextFocus = 'links-search';
    act(async () => {
      await loadLinks();
      category = 'all'; $('links-search').value = ''; refresh();
      message('在默认浏览器中打开');
    });
  };
  $('close-links').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { $('links-form').hidden = true; managing = false; removed = null; $('links-undo').hidden = true; });
  $('links-search').oninput = refresh;
  $('links-manage').onclick = () => { managing = !managing; refresh(); };
  $('links-add').onclick = () => edit();
  $('links-cancel-edit').onclick = () => { $('links-form').hidden = true; $('links-add').focus(); };
  $('links-form').onsubmit = event => {
    event.preventDefault();
    act(async () => {
      const id = $('link-id').value;
      const existing = links.find(link => link.id === id);
      const result = await request('links-save', { id: id || undefined, name: $('link-name').value.trim(),
        url: $('link-url').value.trim(), group: $('link-group').value, note: existing?.note || '', pinned: existing?.pinned || false });
      links = result.links; category = $('link-group').value; $('links-search').value = '';
      $('links-form').hidden = true; message('已保存'); refresh(); dialog.dataset.nextFocus = 'links-add';
    });
  };
  $('links-undo').onclick = () => act(async () => {
    if (!removed) return;
    const result = await request('links-save', removed);
    links = result.links; category = removed.group; removed = null; $('links-undo').hidden = true;
    message('已恢复'); refresh(); dialog.dataset.nextFocus = 'links-manage';
  });
  loadLinks().catch(() => { $('quick-links-list').replaceChildren(el('span', 'quick-links-empty', '链接暂不可用')); });
})();
