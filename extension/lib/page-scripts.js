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
  const REGISTRY = '__dshRefRegistry';
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
  function shadowRootOf(el) {
    try { return el.shadowRoot || null; } catch { return null; }
  }
  function sameOriginFrame(frame) {
    try {
      const doc = frame.contentDocument;
      return doc && doc.body ? doc : null;
    } catch { return null; }
  }
  function composedParent(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  }
  /**
   * Hit-test the point and report the topmost element, crossing shadow boundaries
   * and matching the composed path. \`elementFromPoint\` returns the shadow host for
   * a control inside a shadow root, which would look like an overlay.
   */
  function topAt(x, y) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    let top = document.elementFromPoint(x, y);
    while (top && shadowRootOf(top)) {
      const inner = shadowRootOf(top).elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    return top;
  }
  /** True when \`el\` is \`top\` or inside it, following shadow roots and frames. */
  function containsPoint(top, el) {
    let node = top;
    while (node) {
      if (node === el) return true;
      if (el.contains && el.contains(node)) return true;
      node = composedParent(node);
    }
    return false;
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
  // Refs describe the latest snapshot only: a scoped snapshot restarts at e1, so
  // stale attributes from an earlier walk would win document order.
  for (const stale of document.querySelectorAll('[data-dsh-ref]')) stale.removeAttribute('data-dsh-ref');
  // The registry is the authority for ref -> element. It reaches elements inside
  // open shadow roots and same-origin frames, which a document-wide CSS lookup
  // cannot, and it carries the frame offset a synthesized click needs.
  const registry = new Map();
  try { Object.defineProperty(window, '__dshRefs', { value: registry, configurable: true, writable: true }); }
  catch { window.__dshRefs = registry; }
  let nextRef = 0;
  const refs = [];
  const lines = [];
  let visited = 0;
  let truncated = false;
  let framesWalked = 0;

  function descend(el, depth, offset) {
    for (const child of el.children) walk(child, depth, offset);
    const shadow = shadowRootOf(el);
    if (shadow) {
      lines.push('  '.repeat(depth) + '#shadow-root');
      for (const child of shadow.children) walk(child, depth + 1, offset);
    }
    if (OPT.frames && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      framesWalked += 1;
      const source = (el.getAttribute('src') || '(inline)').slice(0, 160);
      const inner = sameOriginFrame(el);
      if (!inner) {
        lines.push('  '.repeat(depth) + '[cross-origin frame] ' + source + ' — open this url in its own tab to automate it');
        return;
      }
      const box = el.getBoundingClientRect();
      lines.push('  '.repeat(depth) + '[frame] ' + source);
      for (const child of inner.body.children) walk(child, depth + 1, { x: offset.x + box.left, y: offset.y + box.top, frame: el });
    }
  }

  function walk(el, depth, offset) {
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
      registry.set(ref, { el, x: offset.x, y: offset.y, frame: offset.frame });
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
      if (offset.frame) entry.frame = true;
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
      descend(el, depth + (handled ? 1 : 0), offset);
      return;
    }
    const ownText = handled ? '' : (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!handled && ownText && el.children.length === 0) {
      const clipped = ownText.length > OPT.maxText ? ownText.slice(0, OPT.maxText) + '...' : ownText;
      lines.push('  '.repeat(depth) + clipped);
    }
    descend(el, depth + (handled ? 1 : 0), offset);
  }

  walk(root, 0, { x: 0, y: 0, frame: null });
  return {
    ok: true,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    nodesVisited: visited,
    framesWalked,
    truncated,
    outline: lines.join('\\n'),
    refs,
  };
})()`
}

/**
 * Turn the readable part of the page into markdown.
 *
 * This is deliberately a small readability heuristic rather than a full port: it
 * picks the densest article-ish container, drops chrome (nav/footer/aside/form),
 * and emits headings, paragraphs, lists, quotes, code and links. The model reads
 * this instead of a raw HTML dump, which is both smaller and closer to what a
 * human sees.
 *
 * @param {{ selector?: string | null, maxChars?: number }} options
 * @returns {string} IIFE source.
 */
export function markdownScript({ selector = null, maxChars = 20_000 } = {}) {
  return `(() => {
  ${CORE}
  const OPT = ${JSON.stringify({ selector, maxChars })};
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','IFRAME','HEAD','META','LINK','NAV','FOOTER','ASIDE','FORM','BUTTON','SELECT','TEXTAREA','INPUT']);
  const BLOCK = new Set(['P','DIV','SECTION','ARTICLE','MAIN','HEADER','UL','OL','LI','TABLE','PRE','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','FIGURE','FIGCAPTION','DL','DT','DD','TR','BR','HR']);

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  }
  function density(el) {
    const text = textOf(el);
    if (text.length < 200) return 0;
    const links = el.querySelectorAll('a').length;
    const linkText = [...el.querySelectorAll('a')].reduce((sum, a) => sum + (a.innerText || '').length, 0);
    const linkShare = text.length === 0 ? 1 : linkText / text.length;
    return text.length * (1 - Math.min(linkShare, 1));
  }
  function pickRoot() {
    if (OPT.selector) return document.querySelector(OPT.selector);
    const candidates = [...document.querySelectorAll('article, main, [role="main"], .article, .post, .content, #content, .markdown-body')];
    let best = null;
    let bestScore = 0;
    for (const node of candidates) {
      if (!isVisible(node)) continue;
      const score = density(node);
      if (score > bestScore) { bestScore = score; best = node; }
    }
    if (best) return best;
    const body = document.body || document.documentElement;
    const [biggest] = [...body.querySelectorAll('div, section')].map((n) => [n, density(n)]).sort((a, b) => b[1] - a[1]);
    return biggest && biggest[1] > 0 ? biggest[0] : body;
  }

  function inlineOf(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { out += node.nodeValue.replace(/\\s+/g, ' '); continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName;
      if (SKIP.has(tag)) continue;
      if (tag === 'BR') { out += '\\n'; continue; }
      if (tag === 'A') {
        const label = textOf(node).replace(/\\s+/g, ' ');
        const href = node.getAttribute('href') || '';
        out += href && !href.startsWith('javascript:') ? '[' + label + '](' + href.slice(0, 300) + ')' : label;
        continue;
      }
      if (tag === 'STRONG' || tag === 'B') { out += '**' + inlineOf(node).trim() + '**'; continue; }
      if (tag === 'EM' || tag === 'I') { out += '_' + inlineOf(node).trim() + '_'; continue; }
      if (tag === 'CODE') { out += '\`' + textOf(node) + '\`'; continue; }
      if (tag === 'IMG') {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        if (src) out += '![' + alt.slice(0, 80) + '](' + src.slice(0, 300) + ')';
        continue;
      }
      out += inlineOf(node);
    }
    return out;
  }

  function render(el, depth) {
    if (out.length > OPT.maxChars) { truncated = true; return; }
    if (!el || !el.tagName) return;
    if (SKIP.has(el.tagName)) return;
    if (el.hasAttribute && el.getAttribute('aria-hidden') === 'true') return;
    if (!isVisible(el)) return;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const level = '#'.repeat(Number(tag.slice(1)));
      push(level + ' ' + inlineOf(el).replace(/\\s+/g, ' ').trim());
      return;
    }
    if (tag === 'P') { push(inlineOf(el).replace(/\\s+/g, ' ').trim()); return; }
    if (tag === 'UL' || tag === 'OL') {
      let index = 1;
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue;
        const marker = tag === 'OL' ? (index++) + '. ' : '- ';
        const nested = [...li.children].filter((child) => child.tagName === 'UL' || child.tagName === 'OL');
        const own = inlineOf(li).replace(/\\s+/g, ' ').trim();
        push('  '.repeat(depth) + marker + (own || ''));
        for (const sub of nested) render(sub, depth + 1);
      }
      return;
    }
    if (tag === 'PRE') {
      const code = (el.innerText || '').replace(/\\s+$/, '');
      push('\`\`\`' + '\\n' + code + '\\n' + '\`\`\`');
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const quote = textOf(el).split('\\n').map((line) => '> ' + line).join('\\n');
      push(quote);
      return;
    }
    if (tag === 'TABLE') {
      const rows = [...el.querySelectorAll('tr')].slice(0, 60).map((tr) =>
        [...tr.children].map((cell) => (cell.innerText || '').replace(/\\s+/g, ' ').trim()).join(' | '));
      if (rows.length) push(rows.map((row) => '| ' + row + ' |').join('\\n'));
      return;
    }
    if (tag === 'HR') { push('---'); return; }
    if (!BLOCK.has(tag)) {
      const inline = inlineOf(el).replace(/\\s+/g, ' ').trim();
      if (inline) push(inline);
      return;
    }
    for (const child of el.children) render(child, depth);
  }

  const out = [];
  let truncated = false;
  function push(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    out.push(trimmed);
    if (out.join('\\n\\n').length > OPT.maxChars) truncated = true;
  }

  const root = pickRoot();
  if (!root) return { ok: false, error: 'page has no readable body yet' };
  render(root, 0);
  let markdown = out.join('\\n\\n');
  if (markdown.length > OPT.maxChars) { markdown = markdown.slice(0, OPT.maxChars); truncated = true; }
  return {
    ok: true,
    url: location.href,
    title: document.title,
    chars: markdown.length,
    truncated,
    markdown,
  };
})()`
}

/**
 * Collect every table on the page as header/rows pairs.
 *
 * A model that has to count columns out of an outline gets it wrong; handing it
 * row objects it can index is both smaller and unambiguous.
 */
export function tableScript({ selector = null, maxTables = 8, maxRows = 200 } = {}) {
  return `(() => {
  ${CORE}
  const OPT = ${JSON.stringify({ selector, maxTables, maxRows })};
  const roots = OPT.selector ? [...document.querySelectorAll(OPT.selector)] : [...document.querySelectorAll('table')];
  const tables = [];
  for (const table of roots.slice(0, OPT.maxTables)) {
    if (!isVisible(table)) continue;
    const rows = [...table.querySelectorAll('tr')].slice(0, OPT.maxRows).map((tr) => [...tr.children]
      .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
      .map((cell) => (cell.innerText || '').replace(/\\s+/g, ' ').trim()));
    if (rows.length === 0) continue;
    const first = table.querySelector('tr');
    const headerCells = first ? [...first.children].filter((cell) => cell.tagName === 'TH') : [];
    const header = headerCells.length > 0
      ? headerCells.map((cell) => (cell.innerText || '').replace(/\\s+/g, ' ').trim())
      : null;
    const body = header ? rows.slice(1) : rows;
    tables.push({
      header,
      rows: body,
      rowCount: body.length,
      caption: (table.caption ? table.caption.innerText : '').trim().slice(0, 200) || null,
    });
  }
  return { ok: true, url: location.href, count: tables.length, tables };
})()`
}

/**
 * Show a banner the human can click when a task needs a real person.
 *
 * Automation stalls on CAPTCHA, 2FA and payment confirmation. Rather than
 * guessing, the agent parks here: the banner explains what is needed, the tab is
 * brought forward, and the tool resolves the moment the person presses continue.
 */
export function handoffScript({ message, buttonLabel }) {
  return `(() => new Promise((resolve) => {
  const ID = '__dsh_handoff__';
  const existing = document.getElementById(ID);
  if (existing) existing.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.setAttribute('data-dsh-handoff', '1');
  host.style.cssText = 'position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);bottom:24px;display:flex;gap:12px;align-items:center;padding:14px 18px;border-radius:12px;background:#111827;color:#f9fafb;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:min(90vw,720px)';
  const label = document.createElement('span');
  label.textContent = ${JSON.stringify(message)};
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = ${JSON.stringify(buttonLabel)};
  button.style.cssText = 'flex:none;padding:8px 16px;border-radius:8px;border:0;background:#2563eb;color:#fff;font:inherit;cursor:pointer';
  const stop = (value) => { host.remove(); resolve({ ok: true, resumed: value }); };
  button.addEventListener('click', () => stop(true), { once: true });
  host.appendChild(label);
  host.appendChild(button);
  (document.body || document.documentElement).appendChild(host);
  window.__dshHandoff = stop;
  setTimeout(() => { if (document.body && document.body.contains(host)) stop(false); }, 10 * 60 * 1000);
}))()`
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
  ${CORE}
  const entry = ${resolveEntry({ ref, selector })};
  const el = entry.el;
  if (!el) return { ok: false, error: 'element not found' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  // A ref inside a same-origin frame reports frame-local geometry; the click is
  // dispatched against the top-level viewport, so shift it by the frame skew.
  const cx = rect.x + rect.width / 2 + entry.dx;
  const cy = rect.y + rect.height / 2 + entry.dy;
  // Frame-local geometry cannot be hit-tested against the top document, so the
  // coverage check only runs for same-document refs.
  const top = entry.dx || entry.dy ? null : topAt(cx, cy);
  const covered = top && !containsPoint(top, el)
    ? (top.tagName.toLowerCase() + (top.id ? '#' + top.id : ''))
    : null;
  return {
    ok: true,
    x: cx, y: cy,
    width: rect.width, height: rect.height,
    inViewport: cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight,
    coveredBy: covered,
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

/**
 * Scroll the document to its bottom so lazy content exists in the DOM.
 *
 * A full-page capture renders the document without ever scrolling it, so
 * everything a site loads on scroll — `loading="lazy"` images,
 * `IntersectionObserver` batches, infinite-scroll pages — is missing from the
 * image even though the page looks complete in a browser. This walks a real
 * viewport down the page one screen at a time and pauses after each step, which
 * is what those loaders actually watch.
 *
 * The whole pass runs as one page promise: a round trip per step would cost more
 * than the capture. `startScrollTop` lets the caller put the reader back where
 * they were.
 *
 * @param {{ settleMs?: number, maxSteps?: number }} [options]
 * @returns {string} IIFE source resolving to a pass report.
 */
export function lazyScrollScript({ settleMs = 120, maxSteps = 60 } = {}) {
  return `(() => new Promise((resolve) => {
  const settle = (ms) => new Promise((done) => setTimeout(done, ms));
  const read = () => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      scrollHeight: Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0),
      viewport: window.innerHeight || (doc ? doc.clientHeight : 0) || 0,
      scrollTop: Math.round(window.scrollY || (doc ? doc.scrollTop : 0) || 0),
    };
  };
  const start = read();
  const startScrollTop = start.scrollTop;
  if (!(start.viewport > 0) || !(start.scrollHeight > 0)) {
    return resolve({ ok: true, steps: 0, grew: false, atBottom: true, ...start, startScrollTop });
  }
  const stride = Math.max(200, Math.floor(start.viewport * 0.9));
  let height = start.scrollHeight;
  let offset = 0;
  let steps = 0;
  const finish = (atBottom) => resolve({
    ok: true,
    steps,
    grew: height > start.scrollHeight,
    scrollHeight: height,
    viewport: start.viewport,
    startScrollTop,
    atBottom: atBottom === true,
  });
  const step = async () => {
    if (steps >= ${Number(maxSteps)}) return finish(false);
    const top = Math.min(offset, Math.max(0, height - start.viewport));
    window.scrollTo(0, top);
    steps += 1;
    await settle(${Number(settleMs)});
    const now = read();
    const grew = now.scrollHeight > height;
    if (grew) height = now.scrollHeight;
    // The bottom alone is not the end: an infinite-scroll page answers the
    // sentinel with another batch, so stop only once a settle added nothing.
    if (top + start.viewport >= height - 2 && !grew) return finish(true);
    offset = top + stride;
    return step();
  };
  step();
}))()`
}

/** Put the document back at one offset; used after a lazy scroll pass. */
export function restoreScrollScript(scrollTop) {
  return `(() => {
  window.scrollTo(0, ${Math.max(0, Math.floor(Number(scrollTop) || 0))});
  return { ok: true, scrollTop: Math.round(window.scrollY || document.documentElement.scrollTop || 0) };
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
 *
 * The registry installed by the last snapshot wins over the DOM attribute: an
 * element inside an open shadow root or a same-origin frame carries a ref but
 * is unreachable from a document-wide lookup.
 */
function resolveExpression({ ref, selector }) {
  if (ref) {
    return `(() => {
    const hit = window.__dshRefs && window.__dshRefs.get(${JSON.stringify(ref)});
    if (hit && hit.el && hit.el.isConnected) return hit.el;
    return document.querySelector('[data-dsh-ref="' + ${JSON.stringify(ref)} + '"]');
  })()`
  }
  return `document.querySelector(${JSON.stringify(selector)})`
}

/**
 * Expression that resolves both the element and the viewport skew of the frame
 * it lives in, so a synthesized click lands on the right coordinate.
 */
function resolveEntry({ ref, selector }) {
  if (ref) {
    return `(() => {
    const hit = window.__dshRefs && window.__dshRefs.get(${JSON.stringify(ref)});
    if (hit && hit.el && hit.el.isConnected) return { el: hit.el, dx: hit.x || 0, dy: hit.y || 0 };
    return { el: document.querySelector('[data-dsh-ref="' + ${JSON.stringify(ref)} + '"]'), dx: 0, dy: 0 };
  })()`
  }
  return `(() => ({ el: document.querySelector(${JSON.stringify(selector)}), dx: 0, dy: 0 }))()`
}

/**
 * Make the page believe it lives in another timezone.
 *
 * Chrome refuses `Emulation.setTimezoneOverride` to extension debugger clients
 * ("Timezone override is only available to trusted clients"), so the zone is
 * imposed from inside the page instead: `Date` and `Intl` are wrapped to report
 * the requested zone. The wrapper is reversible, and the caller re-installs it
 * with `Page.addScriptToEvaluateOnNewDocument` so it survives navigation.
 */
export function timezoneScript({ timeZone }) {
  if (!timeZone) {
    return `(() => {
  const installed = window.__dshTimezone;
  if (!installed || typeof installed.restore !== 'function') return { ok: true, timeZone: null, restored: false };
  installed.restore();
  return { ok: true, timeZone: null, restored: true };
})()`
  }
  return `(() => {
  const TZ = ${JSON.stringify(timeZone)};
  const VERSION = 2;
  const previous = window.__dshTimezone;
  if (previous && previous.timeZone === TZ && previous.version === VERSION) {
    return { ok: true, timeZone: TZ, installed: false };
  }
  if (previous && typeof previous.restore === 'function') previous.restore();

  const RealDate = Date;
  const RealDTF = Intl.DateTimeFormat;
  const proto = RealDate.prototype;
  const saved = {
    getTimezoneOffset: proto.getTimezoneOffset,
    toString: proto.toString,
    toTimeString: proto.toTimeString,
    toDateString: proto.toDateString,
    toLocaleString: proto.toLocaleString,
    toLocaleDateString: proto.toLocaleDateString,
    toLocaleTimeString: proto.toLocaleTimeString,
    resolvedOptions: RealDTF.prototype.resolvedOptions,
    dateTimeFormat: Intl.DateTimeFormat,
  };

  let formatter;
  try {
    formatter = new RealDTF('en-US', {
      timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: 'short',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (error) {
    return { ok: false, error: 'unknown timezone ' + TZ + ': ' + (error && error.message) };
  }

  const wall = (ms) => {
    const parts = formatter.formatToParts(new RealDate(ms));
    const pick = (type) => {
      for (const part of parts) if (part.type === type) return part.value;
      return '';
    };
    return {
      weekday: pick('weekday'), year: pick('year'), month: pick('month'), day: pick('day'),
      hour: Number(pick('hour')) % 24, minute: pick('minute'), second: pick('second'),
    };
  };

  const pad = (value) => String(value).padStart(2, '0');

  // Minutes to add to UTC to reach local time (the opposite sign of getTimezoneOffset).
  const shiftAt = (ms) => {
    const at = wall(ms);
    const asUTC = RealDate.UTC(Number(at.year), monthIndex(at.month), Number(at.day), at.hour, Number(at.minute), Number(at.second));
    return Math.round((asUTC - ms) / 60000);
  };

  function monthIndex(name) {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const index = names.indexOf(String(name).slice(0, 3));
    return index < 0 ? 0 : index;
  }

  const stamp = (ms) => {
    const at = wall(ms);
    const shift = shiftAt(ms);
    const sign = shift < 0 ? '-' : '+';
    const zone = sign + pad(Math.floor(Math.abs(shift) / 60)) + pad(Math.abs(shift) % 60);
    return {
      date: at.weekday + ' ' + at.month + ' ' + at.day + ' ' + at.year,
      time: pad(at.hour) + ':' + at.minute + ':' + at.second + ' GMT' + zone + ' (' + TZ + ')',
    };
  };

  proto.getTimezoneOffset = function getTimezoneOffset() { return -shiftAt(this.getTime()); };
  proto.toString = function toString() {
    const at = stamp(this.getTime());
    return at.date + ' ' + at.time;
  };
  proto.toTimeString = function toTimeString() { return stamp(this.getTime()).time; };
  proto.toDateString = function toDateString() { return stamp(this.getTime()).date; };

  // toLocaleString(locales, options) takes its options last, so appending a zone
  // must not displace the locale argument: pick the trailing object, if any.
  const withZone = (args) => {
    const copy = Array.prototype.slice.call(args);
    let index = -1;
    for (let i = copy.length - 1; i >= 0; i -= 1) {
      const candidate = copy[i];
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) { index = i; break }
      if (typeof candidate === 'string') break;
    }
    if (index >= 0) {
      if (copy[index].timeZone) return copy;
      copy[index] = { ...copy[index], timeZone: TZ };
      return copy;
    }
    copy.push({ timeZone: TZ });
    return copy;
  };
  proto.toLocaleString = function toLocaleString(...args) {
    return saved.toLocaleString.apply(this, withZone(args));
  };
  proto.toLocaleDateString = function toLocaleDateString(...args) {
    return saved.toLocaleDateString.apply(this, withZone(args));
  };
  proto.toLocaleTimeString = function toLocaleTimeString(...args) {
    return saved.toLocaleTimeString.apply(this, withZone(args));
  };

  const seen = new WeakMap();
  const PatchedDTF = new Proxy(RealDTF, {
    construct(target, args, newTarget) {
      const options = args[1];
      const instance = Reflect.construct(target, args, newTarget);
      seen.set(instance, Boolean(options && typeof options === 'object' && options.timeZone));
      return instance;
    },
    apply(target, thisArg, args) {
      const options = args[1];
      const instance = Reflect.apply(target, thisArg, args);
      seen.set(instance, Boolean(options && typeof options === 'object' && options.timeZone));
      return instance;
    },
  });
  RealDTF.prototype.resolvedOptions = function resolvedOptions() {
    const out = saved.resolvedOptions.call(this);
    if (seen.get(this) !== true) out.timeZone = TZ;
    return out;
  };
  Intl.DateTimeFormat = PatchedDTF;

  window.__dshTimezone = {
    timeZone: TZ,
    version: VERSION,
    offsetMinutes: shiftAt(RealDate.now()),
    restore() {
      proto.getTimezoneOffset = saved.getTimezoneOffset;
      proto.toString = saved.toString;
      proto.toTimeString = saved.toTimeString;
      proto.toDateString = saved.toDateString;
      proto.toLocaleString = saved.toLocaleString;
      proto.toLocaleDateString = saved.toLocaleDateString;
      proto.toLocaleTimeString = saved.toLocaleTimeString;
      RealDTF.prototype.resolvedOptions = saved.resolvedOptions;
      Intl.DateTimeFormat = saved.dateTimeFormat;
      if (window.__dshTimezone && window.__dshTimezone.timeZone === TZ) delete window.__dshTimezone;
    },
  };
  return { ok: true, timeZone: TZ, installed: true, offsetMinutes: shiftAt(RealDate.now()) };
})()`
}
