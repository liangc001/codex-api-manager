// Cache only the appearance preference for first paint. settings.json remains authoritative.
(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'light';
  function apply(value, remember = false) {
    preference = ['light', 'dark', 'system'].includes(value) ? value : 'light';
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    if (remember) { try { localStorage.setItem('appearance-theme', preference); } catch {} }
  }
  try { apply(localStorage.getItem('appearance-theme')); } catch { apply('light'); }
  media.addEventListener('change', () => { if (preference === 'system') apply('system'); });
  window.managerTheme = { apply };
})();
