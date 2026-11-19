// تنبيهات Toast خفيفة.
let toastTimer = null;

export function showToast(msg, ms = 2600) {
  const area = document.getElementById('toast-area');
  if (!area) return;
  area.textContent = '';
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = String(msg ?? '');
  area.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }, ms);
}
