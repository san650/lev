// Defer SW registration to `load` so it doesn't compete with critical
// resource fetches on slow networks (it only intercepts on the next
// navigation anyway). Uses a relative path so the same code works under a
// project subpath.
export function registerServiceWorker(onDbUpdated) {
  if (!('serviceWorker' in navigator)) return;

  const register = () => navigator.serviceWorker.register('./sw.js');
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  // `sw-update-reload` fires once when a NEW SW activates over a prior
  // shell. Reload immediately so the user sees the deploy on the same
  // launch instead of needing a second manual refresh. Guard against
  // duplicate messages with a one-shot flag.
  let reloading = false;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const type = event.data?.type;
    if (type === 'sw-update-reload' && !reloading) {
      reloading = true;
      location.reload();
      return;
    }
    if (type === 'db-updated' && typeof onDbUpdated === 'function') {
      onDbUpdated(event.data);
    }
  });
}
