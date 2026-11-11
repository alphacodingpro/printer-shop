// Tiny helpers shared by all pages. No framework; DOM is built with textContent so user data can never inject markup.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
// The browser's native el.append(null) writes the text "null" (same for false/undefined). Pages build their
// layout with conditionals like `cond && node`, so clear() hands back an element whose append() skips those.
function skipEmpty(el) {
  if (!el.__skipEmpty) {
    const native = el.append.bind(el);
    el.append = (...kids) => native(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    el.__skipEmpty = true;
  }
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return skipEmpty(el); };

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export async function api(path, { method = 'GET', json, form, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (form) body = form;
  let res;
  try { res = await fetch(path, { method, headers, body }); }
  catch { throw Object.assign(new Error('No internet connection. Please try again'), { status: 0 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
  return data;
}

let toastTimer;
export function toast(msg, bad = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

export const money = (n, cur = 'Rs') => `${cur} ${Number(n ?? 0).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
export const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

// ----- i18n (English / Urdu) for customer-facing pages -----
export function makeI18n(dict) {
  let lang = store.get('lang') || ((navigator.language || '').startsWith('ur') ? 'ur' : 'en');
  const apply = () => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ur' ? 'rtl' : 'ltr';
  };
  apply();
  return {
    get lang() { return lang; },
    t: (k, vars = {}) => (dict[lang][k] ?? dict.en[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? ''),
    toggle() { lang = lang === 'ur' ? 'en' : 'ur'; store.set('lang', lang); apply(); },
  };
}
