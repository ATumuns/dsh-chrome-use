/**
 * In-page scripts executed through `Runtime.evaluate`.
 *
 * Each builder returns a self-contained IIFE source string: nothing is injected
 * permanently into the page, `Runtime.evaluate` bypasses page CSP, and every
 * script returns a JSON-serializable value with `returnByValue`.
 *
 * The accessibility snapshot assigns stable `data-dsh-ref` attributes to
 * interactive elements. Refs survive scrolling and re-rendering as long as the
 * element instance survives, and every later action resolves them the same way,
 * so the model never has to reason about coordinates.
 *
 * @module dsh-chrome-use/extension/lib/page-scripts
 */

/** Tag/role heuristics shared by the snapshot script. */
const CORE = String.raw`
  const INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','OPTION','LABEL','DETAILS']);
  const INTERACTIVE_ROLES = new Set(['button','link','checkbox','radio','switch','tab','menuitem','menuitemcheckbox','menuitemradio','option','textbox','searchbox','combobox','listbox','slider','spinbutton','treeitem','gridcell','cell']);
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','PATH','META','LINK','HEAD']);
  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (tag === 'IMG') return el.getAttribute('alt') ? 'img' : 'generic';
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return 'heading';
    if (/^(UL|OL)$/.test(tag)) return 'list';
    if (tag === 'LI') return 'listitem';
    if (tag === 'TABLE') return 'table';
    if (tag === 'TR') return 'row';
    if (tag === 'TD') return 'cell';
    if (tag === 'TH') return 'columnheader';
    if (tag === 'FORM') return 'form';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'MAIN') return 'main';
    if (tag === 'HEADER') return 'banner';
    if (tag === 'FOOTER') return 'contentinfo';
    if (tag === 'ASIDE') return 'complementary';
    if (tag === 'P' || tag === 'SPAN' || tag === 'DIV') return 'generic';
    return 'generic';
  }
  function isInteractive(el, role) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute && (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.isContentEditable)) return true;
    return false;
  }
  function accessibleName(el, role) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelled = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelled) {
      const parts = labelled.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => (n.innerText || '').trim());
      const joined = parts.filter(Boolean).join(' ').trim();
      if (joined) return joined;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (label && label.innerText.trim()) return label.innerText.trim();
      }
      const wrapping = el.closest && el.closest('label');
      if (wrapping && wrapping.innerText.trim()) return wrapping.innerText.trim();
      const placeholder = el.getAttribute('placeholder');
      if (placeholder && placeholder.trim()) return placeholder.trim();
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim();
      const title = el.getAttribute('title');
      if (title && title.trim()) return title.trim();
      if (role === 'button' || role === 'submit') {
        const value = el.getAttribute('value');
        if (value) return value.trim();
      }
    }
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim();
    }
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 120 ? text.slice(0, 117) + '...' : text;
    const title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return '';
  }
  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
`

/**
 * Build the accessibility-ish outline and collect interactive refs.
 * @param {{ maxNodes: number, selector: string | null, interactiveOnly: boolean, maxText: number }} options
 * @returns {string} IIFE source.
 */
export function snapshotScript(options) {
  return `(() => {
  ${CORE}
  const OPT = ${JSON.stringify(options)};
  const root = OPT.selector ? document.querySelector(OPT.selector) : (document.body || document.documentElement);
  if (!root) return { ok: false, error: 'selector matched nothing: ' + OPT.selector };
  let nextRef = 0;
  const refs = [];
  const lines = [];
  let visited = 0;
  let truncated = false;

  function walk(el, depth) {
    if (truncated) return;
    if (visited >= OPT.maxNodes) { truncated = true; return; }
    if (!el || !el.tagName) return;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.hasAttribute && el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true') return;
    visited += 1;
    const role = roleOf(el);
    const visible = isVisible(el);
    const interactive = isInteractive(el, role);
    const name = accessibleName(el, role);
    let handled = false;
    if (visible && interactive) {
      nextRef += 1;
      const ref = 'e' + nextRef;
      el.setAttribute('data-dsh-ref', ref);
      const entry = { ref, role, tag: el.tagName.toLowerCase(), name };
      if (el.tagName === 'A' && el.getAttribute('href')) entry.href = el.getAttribute('href').slice(0, 300);
      if (el.tagName === 'INPUT') {
        entry.type = (el.getAttribute('type') || 'text').toLowerCase();
        if (entry.type === 'checkbox' || entry.type === 'radio') entry.checked = !!el.checked;
        if (el.value && entry.type !== 'password') entry.value = String(el.value).slice(0, 120);
      }
      if (el.tagName === 'SELECT') {
        const selected = [...el.selectedOptions].map((option) => option.value).slice(0, 5);
        if (selected.length) entry.value = selected.join(',');
      }
      if (el.disabled) entry.disabled = true;
      if (el.isContentEditable) entry.editable = true;
      refs.push(entry);
      const flags = [];
      if (entry.disabled) flags.push('disabled');
      if (entry.checked !== undefined) flags.push(entry.checked ? 'checked' : 'unchecked');
      if (entry.type) flags.push(entry.type);
      lines.push('  '.repeat(depth) + '[' + ref + '] ' + role + (name ? ' "' + name.replace(/"/g, '\\\\"') + '"' : '') + (flags.length ? ' (' + flags.join(',') + ')' : ''));
      handled = true;
    } else if (!interactive && (role === 'heading' || role === 'img') && name && visible) {
      lines.push('  '.repeat(depth) + role + (role === 'heading' ? ' ' + el.tagName.toLowerCase() : '') + ' "' + name.replace(/"/g, '\\\\"') + '"');
      handled = true;
    }
    if (OPT.interactiveOnly) {
      for (const child of el.children) walk(child, depth + (handled ? 1 : 0));
      return;
    }
    const ownText = handled ? '' : (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!handled && ownText && el.children.length === 0) {
      const clipped = ownText.length > OPT.maxText ? ownText.slice(0, OPT.maxText) + '...' : ownText;
      lines.push('  '.repeat(depth) + clipped);
    }
    for (const child of el.children) walk(child, depth + (handled ? 1 : 0));
  }

  walk(root, 0);
  return {
    ok: true,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    nodesVisited: visited,
    truncated,
    outline: lines.join('\\n'),
    refs,
  };
})()`
}

/** Focus an element and report whether it took focus. */
export function focusScript({ ref, selector }) {
  return `(() => {
  const el = ${resolveExpression({ ref, selector })};
  if (!el) return { ok: false, error: 'element not found' };
  const rect = el.getBoundingClientRect();
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  try { el.focus({ preventScroll: true }); } catch { el.focus(); }
  return { ok: true, focused: document.activeElement === el, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, tag: el.tagName.toLowerCase(), editable: !!el.isContentEditable };
})()`
}

/** Element geometry plus a viewport-visibility verdict, used before synthesized clicks. */
export function rectScript({ ref, selector }) {
  return `(() => {
  const el = ${resolveExpression({ ref, selector })};
  if (!el) return { ok: false, error: 'element not found' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return {
    ok: true,
    x: cx, y: cy,
    width: rect.width, height: rect.height,
    inViewport: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight,
    coveredBy: top && top !== el && !el.contains(top) ? (top.tagName.toLowerCase() + (top.id ? '#' + top.id : '')) : null,
  };
})()`
}

/** Clear an editable element's current value through native setters. */
export function clearScript({ ref, selector }) {
  return `(() => {
  const el = ${resolveExpression({ ref, selector })};
  if (!el) return { ok: false, error: 'element not found' };
  if (el.isContentEditable) { el.textContent = ''; el.dispatchEvent(new InputEvent('input', { bubbles: true })); return { ok: true }; }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (setter) setter.call(el, ''); else el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`
}

/** Read storage for one area. */
export function storageReadScript(area, keys) {
  return `(() => {
  const store = ${area === 'session' ? 'sessionStorage' : 'localStorage'};
  const wanted = ${JSON.stringify(keys)};
  if (!wanted || wanted.length === 0) {
    const all = {};
    for (let i = 0; i < store.length; i += 1) { const k = store.key(i); all[k] = store.getItem(k); }
    return { ok: true, items: all };
  }
  const picked = {};
  for (const k of wanted) { const v = store.getItem(k); if (v !== null) picked[k] = v; }
  return { ok: true, items: picked };
})()`
}

/** Write storage entries. */
export function storageWriteScript(area, entries) {
  return `(() => {
  const store = ${area === 'session' ? 'sessionStorage' : 'localStorage'};
  for (const [k, v] of Object.entries(${JSON.stringify(entries)})) store.setItem(k, v);
  return { ok: true, written: Object.keys(${JSON.stringify(entries)}).length };
})()`
}

/** Clear one storage area, optionally only listed keys. */
export function storageClearScript(area, keys) {
  return `(() => {
  const store = ${area === 'session' ? 'sessionStorage' : 'localStorage'};
  const keys = ${JSON.stringify(keys)};
  if (!keys || keys.length === 0) { store.clear(); return { ok: true }; }
  for (const k of keys) store.removeItem(k);
  return { ok: true };
})()`
}

/** Poll for a page condition; resolves with `{ok, matched, waitedMs}`. */
export function waitScript({ kind, value, timeoutMs, pollMs }) {
  const probe =
    kind === 'selector'
      ? `!!document.querySelector(${JSON.stringify(value)})`
      : kind === 'text'
        ? `(document.body ? document.body.innerText.includes(${JSON.stringify(value)}) : false)`
        : kind === 'ready'
          ? `document.readyState === 'complete'`
          : `false`
  return `(() => new Promise((resolve) => {
  const deadline = Date.now() + ${Number(timeoutMs)};
  const tick = () => {
    let matched = false;
    try { matched = (${probe}); } catch { matched = false; }
    if (matched) return resolve({ ok: true, matched: true, waitedMs: ${Number(timeoutMs)} - Math.max(0, deadline - Date.now()) });
    if (Date.now() >= deadline) return resolve({ ok: true, matched: false, waitedMs: ${Number(timeoutMs)} });
    setTimeout(tick, ${Number(pollMs)});
  };
  tick();
}))()`
}

/**
 * Expression that resolves an element from either a ref or a CSS selector.
 * Throws inside the page when a ref is present but stale.
 */
function resolveExpression({ ref, selector }) {
  if (ref) {
    return `document.querySelector('[data-dsh-ref="' + ${JSON.stringify(ref)} + '"]')`
  }
  return `document.querySelector(${JSON.stringify(selector)})`
}
