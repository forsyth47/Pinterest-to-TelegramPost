// ==UserScript==
// @name         Pinterest - Post to Telegram
// @namespace    http://tampermonkey.net/
// @version      0.5.0
// @description  Press 'z' to open the original image in a new tab; press 'x' to post it to your Telegram channel
// @author       Valacar + forsyth47
// @include      https://*.pinterest.tld/*
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.telegram.org
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ============================== STORAGE ============================= */
  // All config lives here now — no hardcoded secrets. Edit anytime via the
  // popup UI itself (add bots/channels with "+", tweak the rest with the gear).
  const SK = {
    bots:        'tgpt_bots',        // [{token, label}]
    lastBot:     'tgpt_lastbot',     // token of last used bot
    channels:    'tgpt_channels',    // [{id, label}]
    lastChannel: 'tgpt_lastchannel', // id of last used channel
    prefs:       'tgpt_prefs',       // {theme, scanlines, captionSource, keyOpen, keyPost, activateTab}
  };
  const DEFAULT_PREFS = {
    theme: 2, scanlines: true, captionSource: false,
    keyOpen: 'z', keyPost: 'x', activateTab: true,
  };

  function load(key, fallback) {
    const v = GM_getValue(key);
    return v === undefined ? fallback : v;
  }
  const bots     = () => load(SK.bots, []);
  const channels = () => load(SK.channels, []);
  const getPrefs = () => Object.assign({}, DEFAULT_PREFS, load(SK.prefs, {}));

  let popupOpen = false, sending = false;

  /* ------------------------------ themes ------------------------------ */
  const THEMES = {
    1: { fg: '#39ff6a', bg: '#04140a', dim: '#1d7a41', warn: '#ff5555', border: '#39ff6a' },
    2: { fg: '#ffb000', bg: '#140d02', dim: '#8a6114', warn: '#ff5555', border: '#ffb000' },
    3: { fg: '#7ee7ff', bg: '#031018', dim: '#2b7f96', warn: '#ff5555', border: '#7ee7ff' },
  };
  const C = () => THEMES[getPrefs().theme] || THEMES[1];

  /* ------------------------- image resolution ------------------------- */
  function getReactInfo(pin) {
    return Object.keys(pin).find(prop => prop.startsWith("__reactProps"));
  }
  function getPathToImagesFromChild(obj) {
    if (obj && obj.props) {
      if (obj.props.data && obj.props.data.images) return obj.props.data.images;
      if (obj.props.pin && obj.props.pin.images)   return obj.props.pin.images;
    }
  }
  function getOriginalImage() {
    let path, reactInfo;
    const hoveredElements = document.querySelectorAll(':hover');
    let len = hoveredElements.length;
    while (len--) {
      const el = hoveredElements[len];
      if (reactInfo === undefined) reactInfo = getReactInfo(el);
      if (!reactInfo) continue;
      const target = el[reactInfo];
      if (target && target.children) {
        if (Array.isArray(target.children)) {
          for (let child of target.children) path = getPathToImagesFromChild(child);
        } else {
          path = getPathToImagesFromChild(target.children);
        }
        if (path && path.orig) return path.orig.url;
      }
    }
    len = hoveredElements.length;
    while (len--) {
      const el = hoveredElements[len];
      let img = el.querySelector('img[srcset]');
      if (el && img) {
        for (let src of img.srcset.split(/,\s*/)) {
          if (src.includes('originals')) return src.split(/\s+/)[0];
        }
        return null;
      }
    }
    return null;
  }
  function getPinPageUrl() {
    const hovered = document.querySelectorAll(':hover');
    for (let i = hovered.length - 1; i >= 0; i--) {
      const a = hovered[i].closest ? hovered[i].closest('a[href*="/pin/"]') : null;
      if (a) return a.href;
    }
    return location.href;
  }

  /* ------------------------------ telegram ----------------------------- */
  function tgSendPhoto(token, chatId, imageUrl, caption, onDone) {
    const fd = new FormData();
    fd.append('chat_id', chatId);
    fd.append('photo', imageUrl);
    if (caption) fd.append('caption', caption.slice(0, 1024));
    GM_xmlhttpRequest({
      method: 'POST', url: `https://api.telegram.org/bot${token}/sendPhoto`,
      data: fd, timeout: 20000,
      onload: (res) => {
        let ok = false, desc = '';
        try {
          const j = JSON.parse(res.responseText);
          ok = j.ok; desc = j.description || (ok ? 'OK' : 'UNKNOWN');
        } catch (e) { desc = 'BAD RESPONSE'; }
        onDone(ok, ok ? 'SENT' : `ERR: ${desc} (${res.status})`);
      },
      onerror:   () => onDone(false, 'ERR: NETWORK'),
      ontimeout: () => onDone(false, 'ERR: TIMEOUT'),
    });
  }

  function tgGetMe(token, onDone) {
    GM_xmlhttpRequest({
      method: 'GET', url: `https://api.telegram.org/bot${token}/getMe`, timeout: 10000,
      onload: (res) => {
        let name = null;
        try { const j = JSON.parse(res.responseText); if (j.ok) name = j.result.first_name; } catch (e) {}
        onDone(name);
      },
      onerror:   () => onDone(null),
      ontimeout: () => onDone(null),
    });
  }

  function tgGetChat(token, chatId, onDone) {
    const fd = new FormData();
    fd.append('chat_id', chatId);
    GM_xmlhttpRequest({
      method: 'POST', url: `https://api.telegram.org/bot${token}/getChat`, data: fd, timeout: 10000,
      onload: (res) => {
        let title = null;
        try {
          const j = JSON.parse(res.responseText);
          if (j.ok) title = j.result.title || j.result.first_name || null;
        } catch (e) {}
        onDone(title);
      },
      onerror:   () => onDone(null),
      ontimeout: () => onDone(null),
    });
  }

  /* ------------------------------ helpers ------------------------------ */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  /* ------------------------------ retro UI ----------------------------- */
  function injectStyles() {
    const c = C(), p = getPrefs();
    let s = document.getElementById('tg-retro-style');
    if (!s) { s = document.createElement('style'); s.id = 'tg-retro-style'; document.head.appendChild(s); }
    s.textContent = `
      .tg-retro-root { position: fixed; inset: 0; z-index: 999999;
        font-family: "Courier New", ui-monospace, monospace; }
      .tg-retro-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.55); }
      .tg-retro-box { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: 440px; max-width: 92vw; background: ${c.bg}; color: ${c.fg};
        border: 2px solid ${c.border}; box-shadow: 4px 4px 0 ${c.dim}; padding: 14px 16px; }
      .tg-retro-title { font-weight: bold; letter-spacing: 2px; font-size: 13px;
        border-bottom: 1px dashed ${c.dim}; padding-bottom: 8px; margin-bottom: 10px; }
      .tg-retro-title::before { content: "> "; color: ${c.dim}; }
      .tg-retro-url { font-size: 11px; color: ${c.dim}; word-break: break-all;
        margin-bottom: 10px; max-height: 48px; overflow: hidden; }
      .tg-retro-input { width: 100%; box-sizing: border-box; background: #000; color: ${c.fg};
        border: 1px solid ${c.dim}; font: inherit; font-size: 12px; padding: 6px 8px;
        outline: none; caret-color: ${c.fg}; }
      .tg-retro-input:focus { border-color: ${c.fg}; }
      .tg-retro-input::placeholder { color: ${c.dim}; opacity: .7; }
      .tg-retro-pickers { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
      .tg-retro-picker { display: flex; align-items: center; gap: 6px; }
      .tg-retro-label { width: 60px; flex: none; font-size: 11px; color: ${c.dim}; letter-spacing: 1px; }
      .tg-retro-select { flex: 1; min-width: 0; background: #000; color: ${c.fg};
        border: 1px solid ${c.dim}; font: inherit; font-size: 12px; padding: 5px 6px;
        outline: none; cursor: pointer; }
      .tg-retro-select:focus { border-color: ${c.fg}; }
      .tg-retro-select option { background: #000; color: ${c.fg}; }
      .tg-retro-mini { font: inherit; font-size: 10px; font-weight: bold; letter-spacing: 1px;
        background: transparent; color: ${c.dim}; border: 1px solid ${c.dim};
        padding: 4px 8px; cursor: pointer; flex: none; }
      .tg-retro-mini:hover { color: ${c.fg}; border-color: ${c.fg}; }
      .tg-retro-addcol { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .tg-retro-addrow { display: flex; gap: 8px; justify-content: flex-end; }
      .tg-retro-row { display: flex; gap: 10px; margin-top: 12px; justify-content: flex-end; }
      .tg-retro-btn { font: inherit; font-size: 12px; font-weight: bold; letter-spacing: 1px;
        padding: 6px 14px; cursor: pointer; }
      .tg-retro-send { background: ${c.fg}; color: #000; border: 2px solid ${c.fg}; }
      .tg-retro-send:hover { background: ${c.bg}; color: ${c.fg}; }
      .tg-retro-send:disabled { opacity: .5; cursor: wait; }
      .tg-retro-cancel { background: transparent; color: ${c.dim}; border: 2px solid ${c.dim}; }
      .tg-retro-cancel:hover { color: ${c.fg}; border-color: ${c.fg}; }
      .tg-retro-status { margin-top: 10px; font-size: 11px; min-height: 14px; }
      .tg-retro-status.err { color: ${c.warn}; }
      .tg-retro-gear { position: absolute; left: 10px; bottom: 8px; background: none;
        border: none; color: ${c.dim}; cursor: pointer; line-height: 1; padding: 2px; }
      .tg-retro-gear svg { display: block; }
      .tg-retro-gear:hover { color: ${c.fg}; transform: rotate(30deg); }
      .tg-retro-gear-panel { position: absolute; left: 10px; bottom: 32px; width: 260px;
        background: ${c.bg}; border: 2px solid ${c.border}; box-shadow: 3px 3px 0 ${c.dim};
        padding: 10px 12px; z-index: 2; font-size: 11px; letter-spacing: 1px; }
      .tg-retro-panel-title { font-weight: bold; letter-spacing: 2px;
        border-bottom: 1px dashed ${c.dim}; padding-bottom: 6px; margin-bottom: 8px; }
      .tg-retro-setrow { display: flex; align-items: center; justify-content: space-between;
        gap: 8px; margin: 7px 0; }
      .tg-retro-check { accent-color: ${c.fg}; width: 13px; height: 13px; cursor: pointer; }
      .tg-retro-key { width: 44px; text-align: center; padding: 4px 6px; text-transform: uppercase; }
      .tg-retro-swatches { display: flex; gap: 6px; }
      .tg-retro-swatch { width: 18px; height: 18px; border: 1px solid #000; cursor: pointer; padding: 0; }
      .tg-retro-swatch.active { outline: 2px solid ${c.fg}; }
      .tg-retro-toast-stack { position: fixed; right: 16px; bottom: 16px; z-index: 999999;
        display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
        font-family: "Courier New", ui-monospace, monospace; }
      .tg-retro-toast { background: ${c.bg}; color: ${c.fg}; border: 2px solid ${c.border};
        box-shadow: 3px 3px 0 ${c.dim}; padding: 8px 12px; font-size: 12px; letter-spacing: 1px;
        animation: tg-retro-in .12s steps(2) both; }
      .tg-retro-toast.err { color: ${c.warn}; border-color: ${c.warn}; }
      .tg-retro-toast.out { animation: tg-retro-out .2s steps(3) both; }
      @keyframes tg-retro-in  { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; } }
      @keyframes tg-retro-out { to { opacity: 0; transform: translateX(12px); } }
      ${p.scanlines ? `.tg-retro-box::after { content: ""; position: absolute; inset: 0; pointer-events: none;
        background: repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 1px, transparent 1px 3px); }` : ''}
    `;
  }

  function toast(msg, isErr) {
    injectStyles();
    let stack = document.querySelector('.tg-retro-toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'tg-retro-toast-stack';
      document.body.appendChild(stack);
    }
    const t = document.createElement('div');
    t.className = 'tg-retro-toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    stack.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 3200);
  }

  /* ---------------------------- post popup ----------------------------- */
  function openPostPopup(imageUrl) {
    if (popupOpen) return;
    popupOpen = true;
    injectStyles();

    let captionDraft = getPrefs().captionSource ? getPinPageUrl() : '';
    let gearOpen = false;
    let firstRender = true;

    const root = document.createElement('div');
    root.className = 'tg-retro-root';
    document.body.appendChild(root);

    const close = () => { root.remove(); popupOpen = false; };

    function render() {
      const bList = bots(), cList = channels();
      const lastB = load(SK.lastBot, null), lastC = load(SK.lastChannel, null);
      const bIdx = Math.max(0, bList.findIndex(b => b.token === lastB));
      const cIdx = Math.max(0, cList.findIndex(x => x.id === lastC));
      root.innerHTML = `
        <div class="tg-retro-backdrop"></div>
        <div class="tg-retro-box">
          <div class="tg-retro-title">POST TO TELEGRAM</div>
          <div class="tg-retro-url">${esc(imageUrl)}</div>
          <input id="tg-caption" class="tg-retro-input" type="text" placeholder="caption (optional)..."
                 value="${esc(captionDraft)}" maxlength="1024" spellcheck="false">
          <div class="tg-retro-pickers">
            <div class="tg-retro-picker" data-kind="bot">
              <span class="tg-retro-label">BOT</span>
              <select class="tg-retro-select" data-kind="bot">
                ${bList.length
                  ? bList.map((b, i) => `<option value="${i}" ${i === bIdx ? 'selected' : ''}>${esc(b.label || 'bot')} · ${esc(b.token.split(':')[0])}:…</option>`).join('')
                  : '<option value="">-- add a bot below --</option>'}
              </select>
              <button class="tg-retro-mini" data-add="bot" title="add bot">+</button>
              <button class="tg-retro-mini" data-del="bot" title="remove selected">✕</button>
            </div>
            <div class="tg-retro-picker" data-kind="channel">
              <span class="tg-retro-label">CHANNEL</span>
              <select class="tg-retro-select" data-kind="channel">
                ${cList.length
                  ? cList.map((ch, i) => `<option value="${i}" ${i === cIdx ? 'selected' : ''}>${esc(ch.label || ch.id)}${ch.label ? ' · ' + esc(ch.id) : ''}</option>`).join('')
                  : '<option value="">-- add a channel below --</option>'}
              </select>
              <button class="tg-retro-mini" data-add="channel" title="add channel">+</button>
              <button class="tg-retro-mini" data-del="channel" title="remove selected">✕</button>
            </div>
          </div>
          <div class="tg-retro-status"></div>
          <div class="tg-retro-row">
            <button class="tg-retro-btn tg-retro-cancel">ESC CANCEL</button>
            <button class="tg-retro-btn tg-retro-send">[SEND]</button>
          </div>
          <button class="tg-retro-gear" title="settings"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
        </div>`;
      bind();
      if (gearOpen) renderGear();
    }

    function bind() {
      root.querySelector('.tg-retro-backdrop').addEventListener('click', close);
      root.querySelector('.tg-retro-cancel').addEventListener('click', close);
      root.querySelector('.tg-retro-send').addEventListener('click', doSend);
      root.querySelector('.tg-retro-gear').addEventListener('click', () => { gearOpen = !gearOpen; renderGear(); });
      const cap = root.querySelector('#tg-caption');
      cap.addEventListener('input', () => { captionDraft = cap.value; });
      root.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => showAddForm(b.dataset.add)));
      root.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
        const kind = btn.dataset.del;
        const sel = root.querySelector(`.tg-retro-select[data-kind="${kind}"]`);
        const idx = sel.selectedIndex;
        if (idx < 0) return;
        if (kind === 'bot') {
          const l = bots(); const removed = l.splice(idx, 1)[0]; GM_setValue(SK.bots, l);
          if (load(SK.lastBot) === removed.token) GM_setValue(SK.lastBot, l[0] ? l[0].token : null);
        } else {
          const l = channels(); const removed = l.splice(idx, 1)[0]; GM_setValue(SK.channels, l);
          if (load(SK.lastChannel) === removed.id) GM_setValue(SK.lastChannel, l[0] ? l[0].id : null);
        }
        render();
      }));
      if (firstRender) {
        firstRender = false;
        cap.focus();
        cap.setSelectionRange(cap.value.length, cap.value.length);
      }
    }

    function showAddForm(kind) {
      const picker = root.querySelector(`.tg-retro-picker[data-kind="${kind}"]`);
      const isBot = kind === 'bot';
      picker.innerHTML = `
        <span class="tg-retro-label">${isBot ? 'BOT' : 'CHANNEL'}</span>
        <div class="tg-retro-addcol">
          <input class="tg-retro-input tg-retro-addvalue" placeholder="${isBot ? 'bot token · 123456:AA...' : 'channel · -100123... or @name'}" spellcheck="false">
          <input class="tg-retro-input tg-retro-addlabel" placeholder="label (optional — auto-fetched if empty)..." maxlength="40" spellcheck="false">
          <div class="tg-retro-addrow">
            <button class="tg-retro-mini" data-act="save">SAVE</button>
            <button class="tg-retro-mini" data-act="cancel">CANCEL</button>
          </div>
        </div>`;
      const valueIn = picker.querySelector('.tg-retro-addvalue');
      const labelIn = picker.querySelector('.tg-retro-addlabel');
      const status  = root.querySelector('.tg-retro-status');
      valueIn.focus();
      picker.querySelector('[data-act="save"]').addEventListener('click', () => {
        const value = valueIn.value.trim();
        const label = labelIn.value.trim();
        if (isBot) {
          if (!/^\d{6,}:[\w-]{30,}$/.test(value)) {
            status.classList.add('err'); status.textContent = 'ERR: BAD TOKEN FORMAT'; return;
          }
          const saveBot = (name) => {
            const l = bots();
            l.push({ token: value, label: label || name || ('bot ' + value.split(':')[0]) });
            GM_setValue(SK.bots, l); GM_setValue(SK.lastBot, value);
            render();
          };
          if (label) { saveBot(); return; }
          status.classList.remove('err'); status.textContent = 'FETCHING BOT INFO...';
          tgGetMe(value, (name) => {
            if (!root.isConnected) return;
            if (!name) { status.classList.add('err'); status.textContent = 'ERR: TOKEN REJECTED BY TELEGRAM'; return; }
            saveBot(name);
          });
          return;
        }
        // --- channel ---
        if (!/^@\w{4,}$/.test(value) && !/^-?\d{6,}$/.test(value)) {
          status.classList.add('err'); status.textContent = 'ERR: BAD CHANNEL (need -100... id or @name)'; return;
        }
        const saveChannel = (name) => {
          const l = channels();
          l.push({ id: value, label: label || name || value });
          GM_setValue(SK.channels, l); GM_setValue(SK.lastChannel, value);
          render();
        };
        if (label) { saveChannel(); return; }
        // fetch title via getChat, using the currently selected bot to ask
        const bSel = root.querySelector('.tg-retro-select[data-kind="bot"]');
        const bList = bots();
        const bot = (bSel && bSel.selectedIndex >= 0) ? bList[bSel.selectedIndex] : bList[0];
        if (!bot) { saveChannel(); return; }   // no bot added yet; save id as label
        status.classList.remove('err'); status.textContent = 'FETCHING CHANNEL INFO...';
        tgGetChat(bot.token, value, (name) => {
          if (!root.isConnected) return;
          if (!name) { status.classList.add('err'); status.textContent = 'ERR: CHANNEL NOT FOUND (check id / bot membership)'; return; }
          saveChannel(name);
        });
      });
      picker.querySelector('[data-act="cancel"]').addEventListener('click', render);
    }

    function renderGear() {
      const old = root.querySelector('.tg-retro-gear-panel');
      if (old) old.remove();
      if (!gearOpen) return;
      const p = getPrefs();
      const panel = document.createElement('div');
      panel.className = 'tg-retro-gear-panel';
      panel.innerHTML = `
        <div class="tg-retro-panel-title">SETTINGS</div>
        <div class="tg-retro-setrow"><span>THEME</span>
          <span class="tg-retro-swatches">${[1, 2, 3].map(n =>
            `<button class="tg-retro-swatch${p.theme === n ? ' active' : ''}" data-theme="${n}"
                     style="background:${THEMES[n].fg}" title="theme ${n}"></button>`).join('')}</span></div>
        <label class="tg-retro-setrow"><span>SCANLINES</span>
          <input type="checkbox" class="tg-retro-check" data-pref="scanlines" ${p.scanlines ? 'checked' : ''}></label>
        <label class="tg-retro-setrow"><span>CAPTION SRC URL</span>
          <input type="checkbox" class="tg-retro-check" data-pref="captionSource" ${p.captionSource ? 'checked' : ''}></label>
        <label class="tg-retro-setrow"><span>ACTIVATE NEW TAB</span>
          <input type="checkbox" class="tg-retro-check" data-pref="activateTab" ${p.activateTab ? 'checked' : ''}></label>
        <div class="tg-retro-setrow"><span>KEY: OPEN IMG</span>
          <input class="tg-retro-input tg-retro-key" data-key="keyOpen" value="${esc(p.keyOpen)}" maxlength="1" spellcheck="false"></div>
        <div class="tg-retro-setrow"><span>KEY: TELEGRAM</span>
          <input class="tg-retro-input tg-retro-key" data-key="keyPost" value="${esc(p.keyPost)}" maxlength="1" spellcheck="false"></div>
        <div class="tg-retro-addrow"><button class="tg-retro-mini" data-act="closegear">DONE</button></div>`;
      root.querySelector('.tg-retro-box').appendChild(panel);

      panel.querySelectorAll('.tg-retro-swatch').forEach(sw => sw.addEventListener('click', () => {
        const pr = getPrefs(); pr.theme = +sw.dataset.theme; GM_setValue(SK.prefs, pr);
        injectStyles(); renderGear();
      }));
      panel.querySelectorAll('.tg-retro-check').forEach(cb => cb.addEventListener('change', () => {
        const pr = getPrefs(); pr[cb.dataset.pref] = cb.checked; GM_setValue(SK.prefs, pr);
        injectStyles();
      }));
      panel.querySelectorAll('.tg-retro-key').forEach(inp => inp.addEventListener('change', () => {
        const v = inp.value.trim().toLowerCase();
        const pr = getPrefs();
        if (/^[a-z0-9]$/.test(v)) { pr[inp.dataset.key] = v; GM_setValue(SK.prefs, pr); }
        inp.value = pr[inp.dataset.key];
      }));
      panel.querySelector('[data-act="closegear"]').addEventListener('click', () => { gearOpen = false; renderGear(); });
    }

    function doSend() {
      if (sending) return;
      const bSel = root.querySelector('.tg-retro-select[data-kind="bot"]');
      const cSel = root.querySelector('.tg-retro-select[data-kind="channel"]');
      const bot  = bSel && bSel.selectedIndex >= 0 ? bots()[bSel.selectedIndex] : null;
      const ch   = cSel && cSel.selectedIndex >= 0 ? channels()[cSel.selectedIndex] : null;
      const status  = root.querySelector('.tg-retro-status');
      const sendBtn = root.querySelector('.tg-retro-send');
      if (!bot || !ch) {
        status.classList.add('err');
        status.textContent = 'ADD BOT + CHANNEL FIRST (use +)';
        return;
      }
      sending = true;
      sendBtn.disabled = true;
      status.classList.remove('err');
      status.textContent = 'TRANSMITTING...';
      GM_setValue(SK.lastBot, bot.token);
      GM_setValue(SK.lastChannel, ch.id);
      tgSendPhoto(bot.token, ch.id, imageUrl, captionDraft.trim(), (ok, msg) => {
        sending = false;
        close();
        toast(ok ? `>> SENT // ${ch.label || ch.id}` : msg, !ok);
      });
    }

    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (gearOpen) { gearOpen = false; renderGear(); }
        else close();
      } else if (e.key === 'Enter') {
        const t = e.target;
        if (t.classList.contains('tg-retro-addvalue') || t.classList.contains('tg-retro-addlabel')) {
          e.stopPropagation();
          t.closest('.tg-retro-picker').querySelector('[data-act="save"]').click();
        } else if (t.id === 'tg-caption') {
          e.stopPropagation();
          doSend();
        }
      }
    });

    render();
    // first-run: jump straight into the add forms so setup takes seconds
    if (bots().length === 0) showAddForm('bot');
    else if (channels().length === 0) showAddForm('channel');
  }

  /* ------------------------------ keybinds ----------------------------- */
  function showImage(shouldActivateTab) {
    const imageUrl = getOriginalImage();
    if (imageUrl && /\.(?:jpe?g|png|gif|webp)$/.test(imageUrl)) {
      GM_openInTab(imageUrl, { active: shouldActivateTab });
    }
  }

  window.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.repeat) return;
    if (popupOpen) return; // popup handles its own keys
    if (/(input|textarea)/i.test(document.activeElement.nodeName) ||
        document.activeElement.matches('[role="textarea"]') ||
        document.activeElement.matches('[role="textbox"]')) return;
    const p = getPrefs();
    const key = event.key.toLowerCase();
    if (key === p.keyOpen.toLowerCase()) {
      showImage(event.shiftKey ? !p.activateTab : p.activateTab);
    } else if (key === p.keyPost.toLowerCase()) {
      const imageUrl = getOriginalImage();
      if (imageUrl) openPostPopup(imageUrl);
      else toast('ERR: NO IMAGE FOUND', true);
    } else return;
    event.preventDefault();
  }, true);

})();
