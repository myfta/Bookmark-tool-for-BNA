// ==UserScript==
// @name         Bookmarker for BNA
// @namespace    https://example.com/
// @version      0.8
// @description  Bookmark selections/URLs. Detects underlying <a href> in selection and saves normalized link; resilient floating BM button. Exports/imports JSON. Adds "Delete All" to clear local storage (requires typing DELETE).
// @match        https://www.britishnewspaperarchive.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  // --- GM wrappers ---
  async function gmGet(key, def) {
    if (typeof GM_getValue !== 'undefined') return GM_getValue(key, def);
    if (typeof GM !== 'undefined' && GM.getValue) return await GM.getValue(key, def);
    return def;
  }
  async function gmSet(key, val) {
    if (typeof GM_setValue !== 'undefined') return GM_setValue(key, val);
    if (typeof GM !== 'undefined' && GM.setValue) return await GM.setValue(key, val);
  }

  const STORAGE_KEY = 'tm_bookmarks_v1';

  // --- styles ---
  GM_addStyle(`
    #tm-bookmark-btn { position: fixed !important; right: 14px !important; bottom: 14px !important; z-index: 2147483647 !important; width: 48px !important; height: 48px !important; border-radius: 24px !important; background: #ffcc00 !important; color: #000 !important; display:flex !important; align-items:center !important; justify-content:center !important; cursor:pointer !important; box-shadow: 0 2px 12px rgba(0,0,0,0.4) !important; font-weight:700 !important; user-select:none !important; pointer-events:auto !important; }
    #tm-bm-overlay { position: fixed !important; inset:0 !important; background: rgba(0,0,0,0.35) !important; z-index: 2147483646 !important; }
    #tm-bm-modal { position: fixed !important; left: 50% !important; top: 50% !important; transform: translate(-50%,-50%) !important; z-index: 2147483647 !important; background: #fff !important; color: #000 !important; border: 1px solid #ccc !important; box-shadow: 0 8px 40px rgba(0,0,0,0.45) !important; padding: 12px !important; min-width: 320px !important; max-width: 90% !important; max-height: 80% !important; overflow:auto !important; border-radius:8px !important; }
    #tm-bm-modal input, #tm-bm-modal textarea { width:100% !important; box-sizing:border-box !important; margin:6px 0 !important; padding:8px !important; }
    #tm-bm-actions { display:flex !important; gap:8px !important; justify-content:flex-end !important; margin-top:8px !important; }
    #tm-bm-list { max-height:300px !important; overflow:auto !important; border:1px solid #eee !important; padding:6px !important; background:#fafafa !important; margin-top:8px !important; }
    .tm-bm-item { padding:6px !important; border-bottom:1px dashed #ddd !important; font-size:13px !important; }
    .tm-bm-item strong { display:block !important; }
    .tm-small { font-size:12px !important; color:#666 !important; }
    .tm-link { color:#0066cc !important; text-decoration:underline !important; word-break:break-all !important; }
  `);

  // --- storage helpers ---
  async function loadBookmarks() {
    try {
      const raw = await gmGet(STORAGE_KEY, '[]');
      return JSON.parse(raw || '[]');
    } catch (e) {
      console.error('TM Bookmarker: failed to load bookmarks', e);
      return [];
    }
  }
  async function saveBookmarks(arr) {
    try {
      await gmSet(STORAGE_KEY, JSON.stringify(arr));
    } catch (e) {
      console.error('TM Bookmarker: failed to save bookmarks', e);
    }
  }
  async function clearBookmarks() {
    try {
      await gmSet(STORAGE_KEY, JSON.stringify([]));
    } catch (e) {
      console.error('TM Bookmarker: failed to clear bookmarks', e);
    }
  }
  async function addBookmark(item) {
    const arr = await loadBookmarks();
    arr.unshift(item);
    await saveBookmarks(arr);
  }

  // --- URL detection / normalization (handles relative hrefs) ---
  const URL_RX = /((?:https?:\/\/)[^\s"'<>]+|(?:www\.[^\s"'<>]+)|\b[a-z0-9.-]+\.[a-z]{2,24}(?:\/[^\s"'<>]*)?)/i;
  function stripTrailingPunctuation(s) {
    return s.replace(/[.,:;!?()\]\}"'‾]+$/u, '');
  }
  function normalizeUrl(raw) {
    if (!raw) return null;
    let url = raw.trim();
    url = stripTrailingPunctuation(url);
    // if it's an absolute URL it stays
    if (/^https?:\/\//i.test(url)) {
      try { return new URL(url).href; } catch (e) { /* fall through */ }
    }
    // protocol-less www.
    if (/^www\./i.test(url)) url = 'http://' + url;
    // try to resolve relative or domain-only URLs against document.baseURI
    try {
      const resolved = new URL(url, document.baseURI);
      return resolved.href;
    } catch (e) {
      return null;
    }
  }
  function extractFirstUrlWithRegex(text) {
    if (!text) return null;
    const m = text.match(URL_RX);
    if (!m) return null;
    return normalizeUrl(m[1]);
  }

  // --- anchor detection inside selection/range ---
  function findAnchorAncestor(node) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && n.tagName && n.tagName.toLowerCase() === 'a') {
        const hrefAttr = n.getAttribute && (n.getAttribute('href') || n.href);
        if (hrefAttr) return { node: n, href: hrefAttr };
      }
      n = n.parentNode;
    }
    return null;
  }
  function extractHrefFromSelection() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);

      // check startContainer and endContainer ancestors
      const start = range.startContainer;
      const end = range.endContainer;
      let found = findAnchorAncestor(start) || findAnchorAncestor(end);
      if (found) {
        return normalizeUrl(found.href);
      }

      // check commonAncestorContainer and descendants inside the range
      const cac = range.commonAncestorContainer;
      if (cac && cac.nodeType === 1) {
        const frag = range.cloneContents();
        if (frag && frag.querySelector) {
          const a = frag.querySelector('a[href]');
          if (a) {
            const href = a.getAttribute('href') || a.href;
            return normalizeUrl(href);
          }
        }
      } else if (cac) {
        const pa = cac.parentNode;
        if (pa && pa.querySelector) {
          const a = pa.querySelector && pa.querySelector('a[href]');
          if (a) {
            const href = a.getAttribute('href') || a.href;
            return normalizeUrl(href);
          }
        }
      }

      // no anchor found via DOM; fall back to regex on selected text
      return extractFirstUrlWithRegex(sel.toString());
    } catch (e) {
      return null;
    }
  }

  // --- utility functions ---
  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0,n) + '…' : s;
  }
  async function copyTextToClipboard(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      // fallback
    }
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.left = '-9999px';
    document.documentElement.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }

  // --- robust DOM insertion for button/modal ---
  function safeAppend(el) {
    try {
      if (document.body) {
        document.body.appendChild(el);
      } else if (document.documentElement) {
        document.documentElement.appendChild(el);
      } else {
        document.appendChild(el);
      }
    } catch (e) {
      console.error('TM Bookmarker: append failed', e);
    }
  }

  // --- create button & modal (idempotent) ---
  let btn, overlay, modal;

  function createButtonIfMissing() {
    if (btn && document.body && document.body.contains(btn)) return btn;
    const existing = document.getElementById('tm-bookmark-btn');
    if (existing) existing.remove();

    btn = document.createElement('div');
    btn.id = 'tm-bookmark-btn';
    btn.title = 'Bookmark selection or URL';
    btn.innerText = 'BM';
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.addEventListener('click', onButtonClick, true);
    safeAppend(btn);
    return btn;
  }

  function createModalIfMissing() {
    if (modal && document.body && document.body.contains(modal)) return modal;
    const exOverlay = document.getElementById('tm-bm-overlay'); if (exOverlay) exOverlay.remove();
    const exModal = document.getElementById('tm-bm-modal'); if (exModal) exModal.remove();

    overlay = document.createElement('div'); overlay.id = 'tm-bm-overlay'; overlay.style.display = 'none';
    modal = document.createElement('div'); modal.id = 'tm-bm-modal'; modal.style.display = 'none';

    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0">Add bookmark</h3>
        <button id="tm-bm-close">✕</button>
      </div>
      <label class="tm-small">Title</label>
      <input id="tm-bm-title" placeholder="Title">
      <label class="tm-small">Page URL</label>
      <input id="tm-bm-pageurl" placeholder="Page URL">
      <label class="tm-small">Selected text / URL (the captured item)</label>
      <textarea id="tm-bm-capture" rows="4" placeholder="Selected text or URL"></textarea>
      <input id="tm-bm-original-capture" type="hidden">
      <label class="tm-small">Notes / Tags (optional)</label>
      <input id="tm-bm-notes" placeholder="notes, tags">
      <div id="tm-bm-actions">
        <button id="tm-bm-save">Save</button>
        <button id="tm-bm-export">Export .json</button>
        <button id="tm-bm-import">Import .json</button>
        <button id="tm-bm-showall">View All</button>
        <button id="tm-bm-deleteall" style="background:#e65c5c;color:#fff;border:none;padding:6px 8px;border-radius:4px;">Delete All</button>
      </div>
      <div id="tm-bm-list" style="display:none;"></div>
    `;

    safeAppend(overlay); safeAppend(modal);

    overlay.addEventListener('click', closeModal);
    modal.querySelector('#tm-bm-close').addEventListener('click', closeModal);

    modal.querySelector('#tm-bm-save').addEventListener('click', async () => {
      const title = modal.querySelector('#tm-bm-title').value.trim() || document.title || '';
      const pageurl = modal.querySelector('#tm-bm-pageurl').value.trim() || location.href;
      const captureField = modal.querySelector('#tm-bm-capture').value.trim();
      const originalCapture = modal.querySelector('#tm-bm-original-capture').value || '';
      const notes = modal.querySelector('#tm-bm-notes').value.trim();
      if (!captureField) {
        alert('Please provide selected text or a URL to bookmark (the "capture" field).');
        return;
      }

      // attempt to detect anchor href first (if originalCapture was from selection)
      const detectedFromSelection = originalCapture ? extractHrefFromSelection() : null;
      const normalized = detectedFromSelection || extractFirstUrlWithRegex(captureField) || null;

      const item = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2,8),
        title,
        pageurl,
        capture_text: originalCapture || (normalized ? '' : captureField),
        capture_url: normalized || null,
        capture: normalized || captureField,
        notes,
        created_at: new Date().toISOString(),
        source_hostname: location.hostname,
        capture_is_url: !!normalized
      };
      await addBookmark(item);
      alert('Saved to local bookmarks (Tampermonkey storage). Use Export to save to a file.');
      closeModal();
    });

    modal.querySelector('#tm-bm-export').addEventListener('click', async () => {
      const arr = await loadBookmarks();
      const filename = `tm-bookmarks-${(new Date()).toISOString().replace(/[:.]/g,'-')}.json`;
      const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });

    modal.querySelector('#tm-bm-import').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const text = await f.text();
        try {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error('invalid format: expected array');
          const existing = await loadBookmarks();
          const combined = parsed.concat(existing);
          const map = new Map();
          combined.forEach(it => map.set(it.id || (it.capture+'|'+it.pageurl+'|'+it.created_at), it));
          await saveBookmarks(Array.from(map.values()));
          alert('Imported bookmarks and merged into storage.');
          closeModal();
        } catch (err) {
          alert('Failed to import: ' + err.message);
        }
      });
      input.click();
    });

    modal.querySelector('#tm-bm-showall').addEventListener('click', async () => {
      const container = modal.querySelector('#tm-bm-list');
      const arr = await loadBookmarks();
      container.innerHTML = '';
      if (!arr.length) {
        container.innerHTML = '<div class="tm-small">No bookmarks yet.</div>';
      } else {
        arr.forEach(it => {
          const d = document.createElement('div');
          d.className = 'tm-bm-item';
          const linkHref = it.capture_url || extractFirstUrlWithRegex(it.capture) || null;
          const displayText = it.capture_text && it.capture_text.trim() ? it.capture_text : (it.capture || '');
          let captureHtml = '';
          if (linkHref) {
            captureHtml = `<div><a class="tm-link" href="${escapeAttr(linkHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(displayText || linkHref)}</a></div>`;
          } else {
            captureHtml = `<div>${escapeHtml(truncate(displayText || it.capture, 300))}</div>`;
          }
          d.innerHTML = `<strong>${escapeHtml(it.title)}</strong>
            <div class="tm-small"><a href="${escapeAttr(it.pageurl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.pageurl)}</a></div>
            <div style="margin-top:6px">${captureHtml}</div>
            <div class="tm-small">saved: ${escapeHtml(it.created_at || '')} ${it.notes ? ' • ' + escapeHtml(it.notes) : ''}</div>
            <div style="margin-top:6px">
              <button data-id="${escapeAttr(it.id)}" class="tm-bm-copy">Copy capture</button>
              ${linkHref ? `<button data-url="${escapeAttr(linkHref)}" class="tm-bm-open">Open link</button>` : ''}
              <button data-id="${escapeAttr(it.id)}" class="tm-bm-delete">Delete</button>
            </div>`;
          container.appendChild(d);
        });

        container.querySelectorAll('.tm-bm-copy').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const arr = await loadBookmarks();
            const it = arr.find(x => x.id === id);
            if (it) {
              const textToCopy = it.capture_url || it.capture_text || extractFirstUrlWithRegex(it.capture) || it.capture;
              await copyTextToClipboard(textToCopy);
              alert('Capture copied to clipboard.');
            }
          });
        });
        container.querySelectorAll('.tm-bm-open').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const url = e.currentTarget.getAttribute('data-url');
            if (url) window.open(url, '_blank', 'noopener');
          });
        });
        container.querySelectorAll('.tm-bm-delete').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            if (!confirm('Delete this bookmark?')) return;
            let arr = await loadBookmarks();
            arr = arr.filter(x => x.id !== id);
            await saveBookmarks(arr);
            modal.querySelector('#tm-bm-showall').click();
          });
        });
      }
      container.style.display = 'block';
    });

    // Delete All behaviour
    modal.querySelector('#tm-bm-deleteall').addEventListener('click', async () => {
      try {
        const ok = confirm('Delete ALL bookmarks? This will permanently remove all saved bookmarks from Tampermonkey storage.');
        if (!ok) return;
        const typed = prompt('To confirm deletion of ALL bookmarks, type DELETE (uppercase) and press OK:');
        if (typed !== 'DELETE') {
          alert('Aborted: you must type DELETE to confirm.');
          return;
        }
        await clearBookmarks();
        // refresh view
        const list = modal.querySelector('#tm-bm-list');
        if (list) { list.innerHTML = ''; list.style.display = 'none'; }
        alert('All bookmarks have been deleted.');
      } catch (err) {
        console.error('Failed to delete all bookmarks', err);
        alert('Failed to delete all bookmarks: ' + (err && err.message ? err.message : String(err)));
      }
    });

    return modal;
  }

  // --- selection helpers (include inputs / textareas) ---
  function getSelectionText() {
    try {
      const sel = (window.getSelection && window.getSelection().toString()) || '';
      if (sel && sel.trim().length) return sel.trim();
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /text|search|url|tel|email/i.test(active.type)))) {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        if (typeof start === 'number' && typeof end === 'number' && end > start) {
          return active.value.slice(start, end);
        }
        return active.value || '';
      }
      return '';
    } catch (e) {
      return '';
    }
  }

  // --- open/close modal logic ---
  function openModalWith(initialCapture) {
    createButtonIfMissing();
    createModalIfMissing();
    modal.querySelector('#tm-bm-title').value = document.title || '';
    modal.querySelector('#tm-bm-pageurl').value = location.href;
    modal.querySelector('#tm-bm-notes').value = '';
    modal.querySelector('#tm-bm-list').style.display = 'none';

    // try to detect href from selection (anchor) first
    const hrefFromSelection = extractHrefFromSelection();
    if (hrefFromSelection) {
      modal.querySelector('#tm-bm-capture').value = hrefFromSelection;
      modal.querySelector('#tm-bm-original-capture').value = (initialCapture || '').trim();
      try { const host = new URL(hrefFromSelection).hostname; if (!modal.querySelector('#tm-bm-title').value) modal.querySelector('#tm-bm-title').value = host; } catch(e){}
    } else {
      // fallback to regex detection in the initialCapture text
      const detected = extractFirstUrlWithRegex(initialCapture || '') || null;
      if (detected) {
        modal.querySelector('#tm-bm-capture').value = detected;
        modal.querySelector('#tm-bm-original-capture').value = (initialCapture || '').trim();
        try { const host = new URL(detected).hostname; if (!modal.querySelector('#tm-bm-title').value) modal.querySelector('#tm-bm-title').value = host; } catch(e){}
      } else {
        modal.querySelector('#tm-bm-capture').value = initialCapture || '';
        modal.querySelector('#tm-bm-original-capture').value = '';
      }
    }

    overlay.style.display = 'block';
    modal.style.display = 'block';
  }
  function closeModal() { if (overlay) overlay.style.display = 'none'; if (modal) modal.style.display = 'none'; }

  // --- button click handler ---
  function onButtonClick(e) {
    e.preventDefault(); e.stopPropagation();
    const sel = getSelectionText();
    if (sel && sel.trim().length > 0) {
      openModalWith(sel.trim());
      return;
    }
    const choice = prompt('No selection detected. Enter a URL to bookmark (leave empty to bookmark current page URL):', location.href);
    if (choice === null) return;
    const capture = (choice.trim() === '') ? location.href : choice.trim();
    openModalWith(capture);
  }

  // --- ensure button persists (MutationObserver) ---
  function keepButtonAlive() {
    createButtonIfMissing();
    const mo = new MutationObserver(() => { try { createButtonIfMissing(); } catch (e) {} });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
    window.addEventListener('focus', () => createButtonIfMissing());
  }

  // --- initialize UI and menu commands ---
  try {
    createButtonIfMissing();
    createModalIfMissing();
    keepButtonAlive();
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('TM Bookmarks — Open', () => {
        const sel = getSelectionText();
        openModalWith(sel && sel.trim().length ? sel.trim() : '');
      });
      GM_registerMenuCommand('TM Bookmarks — Export JSON', async () => {
        const arr = await loadBookmarks();
        const filename = `tm-bookmarks-${(new Date()).toISOString().replace(/[:.]/g,'-')}.json`;
        const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
      GM_registerMenuCommand('TM Bookmarks — Delete All', async () => {
        try {
          const ok = confirm('Delete ALL bookmarks? This will permanently remove all saved bookmarks from Tampermonkey storage.');
          if (!ok) return;
          const typed = prompt('To confirm deletion of ALL bookmarks, type DELETE (uppercase) and press OK:');
          if (typed !== 'DELETE') {
            alert('Aborted: you must type DELETE to confirm.');
            return;
          }
          await clearBookmarks();
          alert('All bookmarks have been deleted.');
        } catch (err) {
          console.error('Failed to delete all bookmarks', err);
          alert('Failed to delete all bookmarks: ' + (err && err.message ? err.message : String(err)));
        }
      });
    }
  } catch (err) {
    console.error('TM Bookmarker init error', err);
  }

})();
