// Defer SW registration to `load` so it doesn't compete with critical
// resource fetches on slow networks (it only intercepts on the next
// navigation anyway). Uses a relative path so the same code works under a
// project subpath.
export function registerServiceWorker(onDbUpdated) {
  if (!('serviceWorker' in navigator)) return;

  const register = () => navigator.serviceWorker.register('./sw.js');
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  if (typeof onDbUpdated === 'function') {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'db-updated') onDbUpdated(event.data);
    });
  }
}
