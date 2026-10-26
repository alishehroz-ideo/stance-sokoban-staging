'use strict';
/* STANCE お片づけパズル: GameBull hooks, loaded after the client's app.js (their files unchanged). Classic scripts
 * share globals, so their top-level functions (updateUI) can be wrapped and their lets read (ready, session,
 * joinStage, busy, game, selected). What this adds, all for GameBull Stage Mode only:
 *  - the attempt's time limit (GameBull requires one per attempt) as a small pill in their GameBull status row;
 *  - free replays of cleared stages: their entry card and cost labels say "free" instead of "1ライフ" there;
 *  - the server's clear verdict under their ステージクリア！ card (saved / replay / time exceeded / resend);
 *  - the all-clear voucher card (status from the server), whose button closes the game into the GameBull app's
 *    coupon (gamebull:close + to: /coupons/<id>, relayed by the loading page; trap W18);
 *  - a "back to GameBull" button on their start-up message when the game cannot start (no launch, Game Start);
 *  - the loading page signal, and audioSession "playback" once their sound or music is switched on (trap W2).
 */
(function(){
  const ENV = window.STANCE_GB || {};
  const $ = s => document.querySelector(s);
  const embedded = window.parent !== window;
  const adapter = () => window.StanceGB;
  console.log(`[ST-GB] Build v${ENV.build} (${ENV.gameId}, API ${ENV.apiBase}).`);

  function closeToGameBull(to) {
    if (!embedded) return false;
    const msg = { type: 'gamebull:close' }; if (to) msg.to = to;
    console.log('[ST-GB] gamebull:close ' + JSON.stringify(msg) + ' (through the loading page relay).');
    window.parent.postMessage(msg, location.origin);
    return true;
  }

  /* ── styles for the few GameBull elements (scoped to .stgb-*, trap W10) ── */
  const css = document.createElement('style');
  css.textContent = `
  .stgb-timer{margin-left:auto;margin-right:10px;padding:3px 10px;border-radius:999px;background:#263e48;color:#fff7e6;
    font:700 13px/1.4 system-ui,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap}
  .stgb-timer.stgb-low{background:#b23a2a}
  .stgb-verdict{margin:6px auto 0;max-width:92%;text-align:center;font:700 14px/1.45 system-ui,sans-serif;color:#263e48}
  .stgb-verdict button{all:unset;cursor:pointer;display:inline-block;margin-top:6px;padding:6px 14px;border-radius:10px;
    background:#263e48;color:#fff7e6;font:700 13px system-ui,sans-serif}
  .stgb-reward{position:fixed;inset:0;z-index:1100;display:flex;align-items:center;justify-content:center;
    background:rgba(38,62,72,.62);padding:16px;box-sizing:border-box}
  .stgb-card{width:min(360px,100%);background:#fff7e6;border:3px solid #b9844a;border-radius:18px;padding:20px 18px;
    box-sizing:border-box;text-align:center;color:#263e48;font:500 14px/1.55 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.3)}
  .stgb-card h2{margin:0 0 4px;font-size:22px}
  .stgb-card h3{margin:12px 0 2px;font-size:17px}
  .stgb-card p{margin:6px 0}
  .stgb-card img{display:block;max-width:100%;max-height:160px;margin:10px auto;border-radius:10px}
  .stgb-card button{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;margin-top:10px;padding:11px 12px;
    border-radius:12px;text-align:center;font:700 15px system-ui,sans-serif}
  .stgb-card .stgb-primary{background:#2f8a4f;color:#fff}
  .stgb-card .stgb-secondary{background:#e9dcc2;color:#263e48}
  .stgb-back{all:unset;cursor:pointer;display:block;margin:14px auto 0;padding:10px 18px;border-radius:12px;background:#263e48;
    color:#fff7e6;font:700 14px system-ui,sans-serif;text-align:center}`;
  document.head.appendChild(css);

  /* ── time limit pill ── */
  const timer = document.createElement('span');
  timer.className = 'stgb-timer'; timer.hidden = true; timer.setAttribute('aria-live', 'off');
  const status = $('.gb-status'); if (status) status.insertBefore(timer, $('#gb-live'));
  const fmt = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  let wasExpired = false;
  setInterval(() => {
    const ad = adapter(), a = ad && ad.attempt;
    const show = !!(ready && a && !a.clearBody && session && session.attempt && !joinStage && !game.won);
    timer.hidden = !show;
    if (!show) return;
    const left = ad.remainingMs();
    timer.textContent = left > 0 ? '残り ' + fmt(left) : '時間切れ';
    timer.classList.toggle('stgb-low', left <= 60000);
    const exp = left <= 0;
    if (exp !== wasExpired) { wasExpired = exp; updateUI(); }
  }, 250);

  /* ── their updateUI, then the GameBull Stage Mode labels ── */
  const theirUpdateUI = updateUI;
  const entryText = $('#gb-participate .gb-entry-card p:nth-of-type(2)'), entryRules = $('#gb-participate .gb-entry-rules');
  const entryOriginal = entryText ? entryText.innerHTML : '', rulesOriginal = entryRules ? entryRules.innerHTML : '';
  updateUI = function () {
    theirUpdateUI.apply(this, arguments);
    const ad = adapter(); if (!ready || !ad || !ad.mode || !session) return;
    const a = ad.attempt;
    // Entry card: a cleared stage is a free replay (GameBull freeReplays) — no Life, even at 0 Lives.
    const free = !!joinStage && ad.isFree(joinStage);
    if (entryText) entryText.innerHTML = free ? 'クリア済みのステージは<strong>無料</strong>で遊べます。' : entryOriginal;
    if (entryRules) entryRules.innerHTML = free ? 'リプレイ中は、やり直し・一手戻すも無料です。<br>進捗と報酬は変わりません。' : rulesOriginal;
    if (free) { $('#gb-enter').disabled = busy; $('#gb-enter').textContent = '無料で参加する'; }
    // During a free replay their やり直す / 一手戻す cost nothing either.
    const freeRun = !!(a && a.kind === 'FREE_REPLAY' && session.attempt && !joinStage);
    for (const id of ['#phone-undo', '#phone-reset']) { const small = $(id + ' small'); if (small) small.textContent = freeRun ? '無料' : '−1ライフ'; }
    if (freeRun) {
      const noUndo = busy || game.won || !game.history.length;
      $('#undo').disabled = noUndo; $('#phone-undo').disabled = noUndo;
      $('#reset').disabled = busy; $('#phone-reset').disabled = busy;
      $('#gb-note').textContent = 'リプレイ中：やり直し・一手戻すは無料です。';
    }
    if (a && !game.won && ad.expired() && session.attempt && !joinStage)
      $('#gb-note').textContent = '制限時間を過ぎました。「やり直す」で新しい挑戦を始めてください。';
  };

  /* ── the server's verdict under their ステージクリア！ card ── */
  const verdict = document.createElement('div');
  verdict.className = 'stgb-verdict'; verdict.hidden = true;
  const result = $('#result'); if (result) result.after(verdict);
  const TEXT = { CLEARED: '進捗はGameBullに保存されています。', ALREADY_CLEARED: 'このステージはクリア済みです。',
    REPLAY: 'リプレイ完了：進捗と報酬は変わりません。', TIME_EXCEEDED: '制限時間を過ぎたため、この挑戦はクリアになりませんでした。' };
  addEventListener('stance-gb:clear', e => {
    const d = e.detail;
    verdict.textContent = (d.allCleared && d.status === 'CLEARED' ? '全ステージクリア！ ' : '') + (TEXT[d.status] || '');
    verdict.hidden = false;
    if (d.reward) showReward(d.reward);
  });
  addEventListener('stance-gb:clear-failed', e => {
    verdict.replaceChildren(document.createTextNode(e.detail.message + ' '));
    if (e.detail.canResend) {
      const b = document.createElement('button'); b.textContent = '同じクリア報告を再送';
      // A resend runs outside their transact(), so their screen gets the new progress from the adapter here.
      b.onclick = async () => { b.disabled = true; await adapter().resendClear(); applyGameBullState(adapter().state()); updateUI(); };
      verdict.append(document.createElement('br'), b);
    }
    verdict.hidden = false;
  });
  // A new attempt (or a stage change) clears the line.
  const theirApply = applyGameBullState;
  applyGameBullState = function (next) {
    theirApply.apply(this, arguments);
    const a = adapter() && adapter().attempt;
    if (!a || !a.clearBody) verdict.hidden = true;
    else if (a.result && verdict.hidden) dispatchEvent(new CustomEvent('stance-gb:clear', { detail: a.result }));
  };

  /* ── the all-clear voucher (wording: the client's Niigata Stage Mode screens) ── */
  const safeUrl = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u : null; } catch { return null; } };
  function showReward(reward) {
    if (document.querySelector('.stgb-reward')) return;
    const text = { ISSUED: 'ギフト券が発行され、GameBullのクーポン一覧に入りました。', ALREADY_CLAIMED: 'この店舗の報酬はすでに受け取り済みです。',
      NONE_CONFIGURED: '', OUT_OF_STOCK: '報酬は一時的に在庫切れです。後でGameBullアプリのゲーム画面から受け取れます。' }[reward.status] ?? '報酬の状態はGameBullでご確認ください。';
    const wrap = document.createElement('div'); wrap.className = 'stgb-reward'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
    const card = document.createElement('div'); card.className = 'stgb-card'; wrap.append(card);
    const add = (tag, value) => { if (!value) return null; const el = document.createElement(tag); el.textContent = value; card.append(el); return el; };
    add('h2', '全ステージクリア！');
    if (reward.status !== 'NONE_CONFIGURED') add('h3', reward.title || '全クリア報酬');
    add('p', text); add('p', reward.benefit);
    const img = safeUrl(reward.imageUrl);
    if (img && reward.status !== 'NONE_CONFIGURED') { const im = new Image(); im.alt = reward.title || '全クリア報酬'; im.referrerPolicy = 'no-referrer'; im.src = img.href; card.append(im); }
    const redeem = reward.status === 'ISSUED' && safeUrl(reward.redeemUrl);
    if (redeem) {
      const b = document.createElement('button'); b.className = 'stgb-primary'; b.textContent = 'GameBullでギフト券を開く';
      // Inside the app the frame has no allow-popups: close the game and let the app open the coupon
      // (gamebull-whitelabel d85807c honours to: /coupons/<id>). Outside the app, open the wallet link.
      b.onclick = () => { const m = /^\/coupons\/[^/?#]+$/.exec(redeem.pathname); if (!closeToGameBull(m ? m[0] : undefined)) window.open(redeem.href, '_blank', 'noopener,noreferrer'); };
      card.append(b);
    }
    const c = document.createElement('button'); c.className = 'stgb-secondary'; c.textContent = '閉じる';
    c.onclick = () => wrap.remove(); card.append(c);
    document.body.append(wrap);
    console.log('[ST-GB] All-clear reward card: ' + reward.status + '.');
  }

  /* ── loading page down when their board is ready, or when their start-up message shows ── */
  const loading = $('#loading'), firstText = loading ? loading.textContent : '';
  const wait = setInterval(() => {
    const failed = loading && !loading.hidden && loading.textContent !== firstText;
    if (!(typeof ready !== 'undefined' && ready) && !failed) return;
    clearInterval(wait);
    try { window.parent.gbLoaderProgress && window.parent.gbLoaderProgress(1); window.parent.gbLoaderDone && window.parent.gbLoaderDone(); } catch { /* not in our frame */ }
    if (failed) {
      console.log('[ST-GB] Start-up message: ' + loading.textContent);
      if (embedded) { const b = document.createElement('button'); b.className = 'stgb-back'; b.textContent = 'GameBullに戻る'; b.onclick = () => closeToGameBull(); loading.append(b); }
    }
  }, 100);

  /* ── iPhone: their sounds play with the silent switch on once the player turns sound or music on (trap W2) ── */
  for (const id of ['#sound', '#music']) {
    const el = $(id); if (!el) continue;
    el.addEventListener('click', () => { try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* n/a */ } }, true);
  }
})();
