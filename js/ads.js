// Google AdSense, loaded only after the visitor agrees. Ads appear on the library and add-song screens,
// never in the player, so they cannot get in the way of the controls or compete with playback.
import { ADS } from './ads-config.js';

const KEY = 'stemroom_ads_consent'; // 'yes' | 'no'
const $ = (id) => document.getElementById(id);
export const adsEnabled = () => /^ca-pub-\d{10,}$/.test(ADS.publisher);

function choice() { try { return localStorage.getItem(KEY); } catch { return null; } }
function setChoice(v) { try { localStorage.setItem(KEY, v); } catch {} }

let scriptState = 0; // 0 not loaded, 1 loading/loaded
function loadScript() {
  if (scriptState) return;
  scriptState = 1;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(ADS.publisher);
  document.head.appendChild(s);
}

function fill(box) {
  if (box.querySelector('ins')) return;
  const slot = ADS.slots[box.dataset.slot];
  if (!slot) return;
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle'; ins.style.display = 'block';
  ins.dataset.adClient = ADS.publisher; ins.dataset.adSlot = slot;
  ins.dataset.adFormat = 'auto'; ins.dataset.fullWidthResponsive = 'true';
  box.appendChild(ins);
  try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch {}
}

// view: 'lib' | 'add' | 'play'. `busy` hides the add-song slot while a song is being separated.
export function refreshAds(view, busy) {
  const want = { 'ad-lib': view === 'lib', 'ad-add': view === 'add' && !busy };
  const on = adsEnabled() && choice() === 'yes';
  for (const [id, show] of Object.entries(want)) {
    const el = $(id); if (!el) continue;
    const visible = on && show;
    el.hidden = !visible;
    if (visible) fill(el.querySelector('.adbox'));
  }
}

export function initAds(getView) {
  if (!adsEnabled()) return;
  const refresh = () => refreshAds(getView(), !$('add-progress').hidden);
  const banner = $('consent');
  const sync = () => {
    banner.hidden = choice() !== null;
    $('ad-choices-wrap').hidden = false;
    if (choice() === 'yes') loadScript();
    refresh();
  };
  $('consent-yes').addEventListener('click', () => { setChoice('yes'); sync(); });
  $('consent-no').addEventListener('click', () => { setChoice('no'); sync(); });
  $('ad-choices').addEventListener('click', () => { try { localStorage.removeItem(KEY); } catch {} sync(); });
  new MutationObserver(refresh).observe($('add-progress'), { attributes: true, attributeFilter: ['hidden'] });
  sync();
  return refresh;
}
