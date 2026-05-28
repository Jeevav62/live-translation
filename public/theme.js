// Floating dark/light theme toggle. Persists to localStorage.
// Injected on every page via a <script> tag.
(function () {
  const KEY = 'lt-theme';
  const stored = localStorage.getItem(KEY);
  // Apply before paint to avoid flash.
  if (stored === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  if (stored === 'light') document.documentElement.setAttribute('data-theme', 'light');

  function current() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    btn.title = 'Toggle dark/light mode';
    btn.textContent = current() === 'dark' ? '☀️' : '🌙';
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(KEY, next);
      btn.textContent = next === 'dark' ? '☀️' : '🌙';
    });
  });
})();
