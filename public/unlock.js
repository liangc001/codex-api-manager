(() => {
  window.lucide?.createIcons();
  const input = document.getElementById('startup-password');
  const submit = document.getElementById('unlock-submit');
  const error = document.getElementById('unlock-error');
  const toggle = document.getElementById('toggle-password');
  let waiting = false;
  window.startupAccess.onProgress?.(message => {
    if (waiting && typeof message === 'string') submit.textContent = message;
  });
  toggle.onclick = () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.title = visible ? '隐藏密码' : '显示密码';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.innerHTML = visible ? '<i data-lucide="eye-off"></i>' : '<i data-lucide="eye"></i>';
    window.lucide?.createIcons();
    input.focus();
  };
  document.getElementById('unlock-form').onsubmit = async event => {
    event.preventDefault();
    if (waiting) return;
    waiting = true; submit.disabled = true; error.textContent = '';
    submit.textContent = '正在验证…';
    try {
      const result = await window.startupAccess.unlock(input.value);
      input.value = '';
      input.type = 'password';
      toggle.setAttribute('aria-pressed', 'false'); toggle.title = '显示密码'; toggle.setAttribute('aria-label', toggle.title);
      toggle.innerHTML = '<i data-lucide="eye"></i>'; window.lucide?.createIcons();
      if (result.ok) { submit.textContent = '正在打开…'; return; }
      error.textContent = result.error || '无法解锁，请重试。';
      input.setAttribute('aria-invalid', 'true');
      setTimeout(() => { waiting = false; submit.disabled = false; submit.textContent = '解锁'; input.focus(); }, Math.min(30000, Math.max(0, result.retryAfterMs || 0)));
    } catch {
      input.value = '';
      error.textContent = '无法验证密码，请重新打开软件。';
      waiting = false; submit.disabled = false; submit.textContent = '解锁';
    }
  };
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
})();
