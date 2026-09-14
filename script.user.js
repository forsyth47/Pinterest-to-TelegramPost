// ==UserScript==
// @name         Pinterest - Post to Telegram
// @namespace    http://tampermonkey.net/
// @version      0.4.0
// @description  Press 'z' to open the original image in a new tab; press 'x' to post it to your Telegram channel
// @author       Valacar + forsyth47
// @include      https://*.pinterest.tld/*
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @noframes
// @license      MIT
// ==/UserScript==

(function() {
  'use strict';

  /* ============================== CONFIG ============================== */
  const KEY_TO_OPEN = "z";   // open original image
  const KEY_TO_POST = "x";   // telegram post popup
  const ACTIVATE_NEW_TAB = true;

  const TG_BOT_TOKEN  = "TELEGRAM_BOT_TOKEN";
  const TG_CHANNEL_ID = "TELEGRAM_CHANNEL_ID"; // make sure it has -100 prefix

  const CAPTION_WITH_SOURCE_URL = false; // add user source to caption
  const THEME = 2;        // 1=green phosphor, 2=amber, 3=ice-blue
  const SCANLINES = true;
  /* ==================================================================== */

  const TG_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`;
  let popupOpen = false, sending = false;

  const THEMES = {
    1: { fg:'#39ff6a', bg:'#04140a', dim:'#1d7a41', warn:'#ff5555', border:'#39ff6a' },
    2: { fg:'#ffb000', bg:'#140d02', dim:'#8a6114', warn:'#ff5555', border:'#ffb000' },
    3: { fg:'#7ee7ff', bg:'#031018', dim:'#2b7f96', warn:'#ff5555', border:'#7ee7ff' },
  };
  const C = THEMES[THEME] || THEMES[1];

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
  function tgSendPhoto(imageUrl, caption, onDone) {
    const fd = new FormData();
    fd.append('chat_id', TG_CHANNEL_ID);
    fd.append('photo', imageUrl);
    if (caption) fd.append('caption', caption.slice(0, 1024));
    GM_xmlhttpRequest({
      method: 'POST', url: TG_API, data: fd, timeout: 20000,
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

  /* ------------------------------ retro UI ----------------------------- */
  function injectStyles() {
    if (document.getElementById('tg-retro-style')) return;
    const s = document.createElement('style');
    s.id = 'tg-retro-style';
    s.textContent = `
      .tg-retro-root { position: fixed; inset: 0; z-index: 999999;
        font-family: "Courier New", ui-monospace, monospace; }
      .tg-retro-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.55); }
      .tg-retro-box { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
        width: 420px; max-width: 92vw; background: ${C.bg}; color: ${C.fg};
        border: 2px solid ${C.border}; box-shadow: 4px 4px 0 ${C.dim}; padding: 14px 16px; }
      .tg-retro-title { font-weight: bold; letter-spacing: 2px; font-size: 13px;
        border-bottom: 1px dashed ${C.dim}; padding-bottom: 8px; margin-bottom: 10px; }
      .tg-retro-title::before { content: "> "; color: ${C.dim}; }
      .tg-retro-url { font-size: 11px; color: ${C.dim}; word-break: break-all;
        margin-bottom: 10px; max-height: 48px; overflow: hidden; }
      .tg-retro-input { width: 100%; box-sizing: border-box; background: #000; color: ${C.fg};
        border: 1px solid ${C.dim}; font: inherit; font-size: 12px; padding: 6px 8px;
        outline: none; caret-color: ${C.fg}; }
      .tg-retro-input:focus { border-color: ${C.fg}; }
      .tg-retro-row { display: flex; gap: 10px; margin-top: 12px; justify-content: flex-end; }
      .tg-retro-btn { font: inherit; font-size: 12px; font-weight: bold; letter-spacing: 1px;
        padding: 6px 14px; cursor: pointer; }
      .tg-retro-send { background: ${C.fg}; color: #000; border: 2px solid ${C.fg}; }
      .tg-retro-send:hover { background: ${C.bg}; color: ${C.fg}; }
      .tg-retro-send:disabled { opacity: .5; cursor: wait; }
      .tg-retro-cancel { background: transparent; color: ${C.dim}; border: 2px solid ${C.dim}; }
      .tg-retro-cancel:hover { color: ${C.fg}; border-color: ${C.fg}; }
      .tg-retro-status { margin-top: 10px; font-size: 11px; min-height: 14px; }
      .tg-retro-status.err { color: ${C.warn}; }
      .tg-retro-toast-stack { position: fixed; right: 16px; bottom: 16px; z-index: 999999;
        display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
        font-family: "Courier New", ui-monospace, monospace; }
      .tg-retro-toast { background: ${C.bg}; color: ${C.fg}; border: 2px solid ${C.border};
        box-shadow: 3px 3px 0 ${C.dim}; padding: 8px 12px; font-size: 12px; letter-spacing: 1px;
        animation: tg-retro-in .12s steps(2) both; }
      .tg-retro-toast.err { color: ${C.warn}; border-color: ${C.warn}; }
      .tg-retro-toast.out { animation: tg-retro-out .2s steps(3) both; }
      @keyframes tg-retro-in  { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; } }
      @keyframes tg-retro-out { to { opacity: 0; transform: translateX(12px); } }
      ${SCANLINES ? `.tg-retro-box::after { content: ""; position: absolute; inset: 0; pointer-events: none;
        background: repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 1px, transparent 1px 3px); }` : ''}
    `;
    document.head.appendChild(s);
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

  function openPostPopup(imageUrl) {
    if (popupOpen) return;
    popupOpen = true;
    injectStyles();

    const root = document.createElement('div');
    root.className = 'tg-retro-root';
    root.innerHTML = `
      <div class="tg-retro-backdrop"></div>
      <div class="tg-retro-box">
        <div class="tg-retro-title">POST TO TELEGRAM</div>
        <div class="tg-retro-url">${imageUrl}</div>
        <input class="tg-retro-input" type="text" placeholder="caption (optional)..."
               value="${CAPTION_WITH_SOURCE_URL ? getPinPageUrl() : ''}" maxlength="1024">
        <div class="tg-retro-status"></div>
        <div class="tg-retro-row">
          <button class="tg-retro-btn tg-retro-cancel">ESC CANCEL</button>
          <button class="tg-retro-btn tg-retro-send">[SEND]</button>
        </div>
      </div>`;
    document.body.appendChild(root);

    const input   = root.querySelector('.tg-retro-input');
    const status  = root.querySelector('.tg-retro-status');
    const sendBtn = root.querySelector('.tg-retro-send');
    const close   = () => { root.remove(); popupOpen = false; };

    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    const doSend = () => {
      if (sending) return;
      sending = true;
      status.classList.remove('err');
      status.textContent = 'TRANSMITTING...';
      sendBtn.disabled = true;
      close();                                    // hide popup right away
      tgSendPhoto(imageUrl, input.value.trim(), (ok, msg) => {
        sending = false;
        if (ok) { toast('>> SENT TO CHANNEL'); close(); }
        else {
          status.classList.add('err'); status.textContent = msg;
          sendBtn.disabled = false; toast(msg, true);
        }
      });
    };

    root.querySelector('.tg-retro-send').addEventListener('click', doSend);
    root.querySelector('.tg-retro-cancel').addEventListener('click', close);
    root.querySelector('.tg-retro-backdrop').addEventListener('click', close);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter')  { e.stopPropagation(); doSend(); }
    });
  }

  /* ------------------------------ keybinds ----------------------------- */
  window.addEventListener("keydown", function(event) {
    if (event.defaultPrevented || event.repeat ||
        /(input|textarea)/i.test(document.activeElement.nodeName) ||
        document.activeElement.matches('[role="textarea"]') ||
        document.activeElement.matches('[role="textbox"]')) return;
    const key = event.key.toLowerCase();
    if (key === KEY_TO_OPEN.toLowerCase()) {
      showImage(event.shiftKey ? !ACTIVATE_NEW_TAB : ACTIVATE_NEW_TAB);
    } else if (key === KEY_TO_POST.toLowerCase()) {
      const imageUrl = getOriginalImage();
      if (imageUrl) openPostPopup(imageUrl);
      else toast('ERR: NO IMAGE FOUND', true);
    } else return;
    event.preventDefault();
  }, true);

  function showImage(shouldActivateTab) {
    const imageUrl = getOriginalImage();
    if (imageUrl && /\.(?:jpe?g|png|gif|webp)$/.test(imageUrl)) {
      GM_openInTab(imageUrl, {active: shouldActivateTab});
    }
  }
})();
