// Shows the build number in the page footer. The number is the version in the
// service worker's cache name (sw.js), so bumping that one value updates it everywhere.
(async () => {
  const els = document.querySelectorAll('[data-build]');
  if (!els.length) return;
  try {
    const r = await fetch('sw.js');
    const m = /stemroom-app-v(\d+)/.exec(await r.text());
    if (m) els.forEach((el) => { el.textContent = 'Build ' + m[1]; });
  } catch (e) { /* offline and not cached yet: leave blank */ }
})();
