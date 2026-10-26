'use strict';
/* STANCE お片づけパズル: GameBull Stage Mode adapter.
 *
 * The client's own host boundary (their GAMEBULL-INTEGRATION.md): with adapterMode:'host' their gamebull.js calls
 * window.GameBullAdapterFactory({companyId, levelSetVersion}) and then only initialize() and transact(request).
 * Their request contract ({action: enter|move|undo|restart, operationId, attemptId, revision, levelId, direction})
 * was their proposal, not a GameBull API, so this file maps it onto the real GameBull Stage Mode API
 * (gamebull-whitelabel ADR-0086, contracts/stage-mode.ts), the same API the rice field game (Niigata) uses:
 *
 *   initialize          GET  /play/games/{gameId}/context?tenantSlug   (Bearer bootToken) -> stageMode, lives.count
 *   enter / restart     POST /play/plays {bootToken, stage}            1 Life on the server (PAID); a cleared stage is
 *                                                                       a FREE_REPLAY (no Life) when freeReplays is on
 *   undo                POST /me/lives/consume                          (Bearer playToken) 1 Life, same attempt and
 *                                                                       deadline; free during a FREE_REPLAY
 *   move                local, with their own Sokoban engine (GameBull does not validate moves)
 *   the move that wins  POST /play/stage-clears {sessionToken, playTimeMs} -> status + reward (the all-clear voucher is
 *                                                                       issued by the server, once per player)
 *
 * Lives are never subtracted here: the balance shown is always the server's (lives.count, or consume's remaining).
 * The board of a running attempt (with its play token) is kept in sessionStorage, so a reload in the same tab
 * resumes it without a free restart, as their demo did; closing the game ends it (the token stays only in this tab).
 * Their files are unchanged; the build switches their enterprise-config.js adapterMode to 'host'.
 */
(function(){
  const ENV = window.STANCE_GB || {};
  const log = (...a) => console.log('[ST-GB]', ...a);

  class StageError extends Error { constructor(code, message) { super(message); this.name = 'StageError'; this.code = code; } }
  // Server error codes -> the client's own Japanese wording (their Niigata Stage Mode adapter, same client), plus
  // their Stance demo's wording for the rules they already had.
  const MESSAGES = {
    'play.no_lives': 'ライフが足りません。GameBullに戻って確認してください。',
    'stage.daily_limit_reached': '本日の挑戦回数の上限に達しました。進捗は保存されています。',
    'stage.stage_not_playable': 'このステージはまだプレイできません。進捗を更新します。',
    'stage.all_cleared': 'すべてのステージをクリア済みです。',
    'stage.stage_required': 'ステージ番号の送信に問題があります。開発者へお問い合わせください。',
    'stage.play_token_required': '挑戦情報を確認できません。開発者へお問い合わせください。',
    'play.session_token_expired': '挑戦の有効期限が切れました。新しい挑戦を開始してください。',
    'play.session_token_invalid': 'GameBullへの接続に失敗しました。GameBullのゲーム画面から開き直してください。',
    'guest.session_invalid': 'GameBullへの接続に失敗しました。GameBullのゲーム画面から開き直してください。',
    'stage.score_not_accepted': 'クリア報告の設定に問題があります。開発者へお問い合わせください。',
    'play.mode_not_enabled': 'このゲームのステージモードをGameBull側で有効にしてください。'
  };
  const fail = (code, message) => new StageError(code, message || MESSAGES[code] || 'GameBullへの接続に失敗しました。');
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const jwtPayload = t => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; } };
  const safe = (store, fn) => { try { return fn(store); } catch { return null; } };

  class StanceStageAdapter {
    constructor({ companyId, levelSetVersion, levels, Engine }) {
      this.companyId = companyId; this.levelSetVersion = levelSetVersion; this.levels = levels; this.Engine = Engine;
      this.token = ''; this.tenant = ''; this.ctx = null; this.ctxAt = 0; this.attempt = null;
      this.revision = 0; this.applied = []; this.busy = false; this.uncertainStart = false; this.lastClear = null;
      const q = new URLSearchParams(location.search);
      // The GameBull app launches with ?tenantSlug&bootToken&gameId&returnUrl&apiBase (use-launch-game.ts); the
      // other ports' SDK also accepts sessionToken / token, in that order (playbook section 2).
      this.token = q.get('bootToken') || q.get('sessionToken') || q.get('token') || '';
      this.tenant = q.get('tenantSlug') || '';
      this.gameId = ENV.gameId;
      this.api = ((ENV.dev && q.get('devApi')) || ENV.apiBase || '').replace(/\/+$/, '');
      const boot = jwtPayload(this.token) || {};
      this.player = boot.globalUserId || 'unknown';
      this.attemptKey = 'stance-gb:v1:attempt:' + this.tenant + ':' + this.gameId + ':' + this.player;
      this.bestKey = 'stance-gb:v1:best:' + this.tenant + ':' + this.gameId + ':' + this.player;
    }

    /* ── server ─────────────────────────────────────────────────────────── */
    async request(path, { method = 'GET', body, bearer } = {}) {
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 15000);
      const headers = { Accept: 'application/json' };
      if (bearer) headers.Authorization = 'Bearer ' + bearer;
      if (body) headers['Content-Type'] = 'application/json';
      // GETs are cache-busted with a unique URL (a cached /context showed lives one play behind, playbook section 3).
      const url = this.api + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + '_ts=' + Date.now() + '-' + (++this._n || (this._n = 1)) : '');
      let response, data;
      try {
        response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: abort.signal,
          cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      } catch { throw fail('network', '通信結果を確認できませんでした。接続を確認してください。'); }
      finally { clearTimeout(timeout); }
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        // Codes arrive nested ({error:{code}}) or top-level ({code}) (playbook section 3, error shapes).
        const code = (data && data.error && data.error.code) || (data && typeof data.code === 'string' && data.code) || 'http_' + response.status;
        const e = fail(code, MESSAGES[code] || (response.status >= 500 ? 'GameBullへの接続に失敗しました。時間をおいてお試しください。' : 'GameBullへの接続に失敗しました。'));
        e.httpStatus = response.status; throw e;
      }
      if (!data || typeof data !== 'object') throw fail('bad_response', 'GameBullからの応答を確認できませんでした。');
      return data;
    }

    async refresh() {
      const data = await this.request('/play/games/' + encodeURIComponent(this.gameId) + '/context?tenantSlug=' + encodeURIComponent(this.tenant), { bearer: this.token });
      const m = data.stageMode;
      // stageMode is sent only for a "Play Stage Mode" launch (boot token mode STAGE_CLEAR); "Game Start" gets null.
      if (!m) throw fail('stage_mode_required', 'このゲームはステージモードで遊べます。GameBullのゲーム画面の「Play Stage Mode」から開いてください。');
      const n = m.totalStages, h = m.highestCleared;
      if (!Number.isInteger(n) || n < 1 || n > this.levels.length || !Number.isInteger(h) || h < 0 || h > n
        || (h >= n ? m.nextStage !== null : m.nextStage !== h + 1) || typeof m.freeReplays !== 'boolean' || !(m.maxAttemptSeconds > 0))
        throw fail('bad_context', 'ステージ情報がゲームと一致しません。管理者に確認してください。');
      this.ctx = data; this.ctxAt = Date.now();
      return data;
    }
    get mode() { return this.ctx && this.ctx.stageMode; }
    get lives() { const n = this.ctx && this.ctx.lives && this.ctx.lives.count; return Number.isInteger(n) && n >= 0 ? n : 0; }
    canStart(stage) { const m = this.mode; return !!m && Number.isInteger(stage) && (stage === m.nextStage || (m.freeReplays && stage >= 1 && stage <= m.highestCleared)); }
    isFree(stage) { const m = this.mode; return !!m && m.freeReplays && stage >= 1 && stage <= m.highestCleared; }

    async start(stage) {
      if (this.uncertainStart) throw fail('start_unknown', '前回の開始結果が不明です。進捗を再取得してから、新しい挑戦を選んでください。');
      if (!this.canStart(stage)) throw fail('stage.stage_not_playable', stage > (this.mode.nextStage || this.mode.totalStages) ? '前のステージをクリアしてください。' : undefined);
      let data;
      try { data = await this.request('/play/plays', { method: 'POST', body: { bootToken: this.token, stage } }); }
      catch (e) {
        // No idempotency key on this call: an unknown answer is never retried (a Life may already be spent).
        if (e.code === 'network' || e.httpStatus >= 500) { this.uncertainStart = true; e.message = 'ライフが使われた可能性があります。進捗を再取得してから、新しい挑戦を選んでください。'; }
        throw e;
      }
      const sm = data.stageMode, deadline = Date.parse(sm && sm.deadlineAt), expires = Date.parse(data.expiresAt);
      if (typeof data.playToken !== 'string' || !data.playToken || data.mode !== 'STAGE_CLEAR' || !sm || sm.stage !== stage
        || !['PAID', 'FREE_REPLAY'].includes(sm.kind) || !Number.isFinite(deadline) || !(sm.maxAttemptSeconds > 0))
        throw fail('bad_response', '挑戦の開始情報を確認できませんでした。');
      const startedAt = Date.now(), g = new this.Engine(this.levels[stage - 1]);
      this.attempt = { id: data.playToken.slice(-16) + ':' + startedAt, stage, token: data.playToken, kind: sm.kind, startedAt,
        deadline: Math.min(deadline, Number.isFinite(expires) ? expires : Infinity, startedAt + sm.maxAttemptSeconds * 1000),
        map: g.map, engine: JSON.parse(g.snapshot()), history: [], clearBody: null, result: null, clearFailed: null };
      log(`Stage ${stage} started (${sm.kind}${sm.kind === 'PAID' ? ', 1 Life' : ', free'}), limit ${sm.maxAttemptSeconds} s.`);
      try { await this.refresh(); } catch { /* the start stands; lives refresh on the next call */ }
      this.save();
    }

    async consumeLife() {
      let data;
      try { data = await this.request('/me/lives/consume', { method: 'POST', bearer: this.attempt.token }); }
      catch (e) {
        if (e.code === 'network' || e.httpStatus >= 500) {
          try { await this.refresh(); } catch { /* keep the message below */ }
          e.message = 'ライフの消費結果を確認できませんでした。残りライフを確認してから、もう一度お試しください。';
        } else if (e.code === 'play.no_lives') { try { await this.refresh(); } catch { /* shown as 0 below */ } }
        throw e;
      }
      if (!Number.isInteger(data.remaining)) throw fail('bad_response', 'GameBullからの応答を確認できませんでした。');
      this.ctx = { ...this.ctx, lives: { ...(this.ctx.lives || {}), count: data.remaining, max: data.max } };
      log(`Undo: 1 Life consumed on the server, ${data.remaining} left.`);
    }

    async sendClear() {
      const a = this.attempt;
      if (!a || !a.clearBody || a.result) return;
      try {
        const data = await this.request('/play/stage-clears', { method: 'POST', body: a.clearBody });
        if (!['CLEARED', 'ALREADY_CLEARED', 'REPLAY', 'TIME_EXCEEDED'].includes(data.status) || data.stage !== a.stage)
          throw fail('bad_response', 'クリア判定を確認できませんでした。');
        a.result = data; a.clearFailed = null; this.lastClear = data;
        if (data.status !== 'TIME_EXCEEDED') {
          this.ctx = { ...this.ctx, stageMode: { ...this.mode, highestCleared: data.highestCleared, nextStage: data.nextStage, totalStages: data.totalStages,
            rewardClaimed: (data.reward && data.reward.status === 'ISSUED') || this.mode.rewardClaimed } };
        }
        log(`Stage ${a.stage} clear: ${data.status} (${data.highestCleared}/${data.totalStages} cleared${data.reward ? ', reward ' + data.reward.status : ''}).`);
        try { await this.refresh(); } catch { /* the clear response is authoritative */ }
        dispatchEvent(new CustomEvent('stance-gb:clear', { detail: data }));
      } catch (e) {
        // Safe resend: the same play token and playTimeMs (the server answers a repeat with its stored verdict).
        a.clearFailed = e.message; log(`Stage ${a.stage} clear not confirmed (${e.code}); resend offered.`);
        if (e.code === 'play.session_token_expired') a.clearBody = null;
        dispatchEvent(new CustomEvent('stance-gb:clear-failed', { detail: { message: e.message, canResend: !!a.clearBody } }));
      }
      this.save();
    }
    async resendClear() { if (this.busy) return; this.busy = true; try { await this.sendClear(); } finally { this.busy = false; } }

    /* ── attempt, storage, state for their UI ──────────────────────────── */
    remainingMs() { const a = this.attempt; return a ? Math.max(0, a.deadline - Date.now()) : 0; }
    expired() { const a = this.attempt; return !!a && !a.clearBody && this.remainingMs() <= 0; }
    engine() {
      const a = this.attempt, g = new this.Engine({ ...this.levels[a.stage - 1], map: a.map });
      Object.assign(g, JSON.parse(JSON.stringify(a.engine))); g.history = a.history.slice(); return g;
    }
    keep(g) { this.attempt.engine = JSON.parse(g.snapshot()); this.attempt.history = g.history.slice(); }
    save() { safe(sessionStorage, s => this.attempt ? s.setItem(this.attemptKey, JSON.stringify(this.attempt)) : s.removeItem(this.attemptKey)); }
    restore() {
      const a = safe(sessionStorage, s => JSON.parse(s.getItem(this.attemptKey)));
      const exp = a && jwtPayload(a.token);
      // Only an attempt still in play (or a clear still waiting for the server) comes back; a finished one would
      // reopen on its old result instead of the next stage's entry card.
      if (!a || !exp || exp.exp * 1000 <= Date.now() || !Number.isInteger(a.stage) || a.stage > this.mode.totalStages || a.result
        || (a.clearBody === null && a.clearFailed)) { this.attempt = null; this.save(); return; }
      this.attempt = a; log(`Stage ${a.stage} attempt restored after a reload.`);
    }
    bests() { return safe(localStorage, s => JSON.parse(s.getItem(this.bestKey))) || {}; }
    recordBest(g) {
      const b = this.bests(), old = b[g.id];
      b[g.id] = { moves: Math.min(old && old.moves != null ? old.moves : Infinity, g.moves), stars: Math.max(old ? old.stars || 0 : 0, g.collected) };
      safe(localStorage, s => s.setItem(this.bestKey, JSON.stringify(b)));
    }
    state() {
      const m = this.mode, b = this.bests(), clears = {};
      // Progress is the server's (highestCleared); best moves / stars are this browser's, for their stage list only.
      for (let i = 1; i <= m.highestCleared; i++) clears[i] = b[i] || { moves: '—', stars: 0 };
      const a = this.attempt;
      return { schema: 1, companyId: this.companyId, levelSetVersion: this.levelSetVersion, balance: this.lives,
        unlocked: m.nextStage || m.totalStages, clears, revision: this.revision,
        attempt: a ? { id: a.id, levelId: a.stage, map: a.map, engine: a.engine, history: a.history.slice() } : null };
    }

    /* ── the client's adapter contract ─────────────────────────────────── */
    async initialize() {
      if (!this.api) throw fail('not_configured', 'GameBullの接続先が未設定です。開発者に接続設定を依頼してください。');
      if (!this.token || !this.tenant) throw fail('launch_required', 'GameBullのゲーム画面から開いてください。');
      // Their UI calls initialize() again after every failed request: a fresh /context at most every 5 s.
      if (!this.ctx || Date.now() - this.ctxAt > 5000) {
        const first = !this.ctx;
        await this.refresh();
        this.uncertainStart = false; // the refresh the uncertain start asked for; the player now chooses again
        if (first) {
          this.restore();
          const m = this.mode;
          log(`Build v${ENV.build}. /context has stageMode (cleared ${m.highestCleared}/${m.totalStages}, next ${m.nextStage}, ` +
            `${m.maxAttemptSeconds} s per attempt, free replays ${m.freeReplays ? 'on' : 'off'}), ${this.lives} Lives.`);
          if (this.attempt && this.attempt.clearBody && !this.attempt.result) await this.sendClear();
        }
      }
      return this.state();
    }

    async transact(request) {
      if (this.applied.includes(request.operationId)) return this.state();
      if (this.busy) throw fail('busy', '通信中です。しばらくお待ちください。');
      if (request.revision !== this.revision) throw fail('stale', '別の画面で更新されています。読み込み直してください。');
      this.busy = true;
      try {
        const action = request.action, a = this.attempt;
        if (action === 'enter') {
          const n = request.levelId;
          if (!Number.isInteger(n) || n < 1 || n > this.mode.totalStages) throw fail('no_stage', 'ステージがありません。');
          if (n > (this.mode.nextStage || this.mode.totalStages)) throw fail('locked', '前のステージをクリアしてください。');
          await this.start(n);
        } else if (action === 'refill-demo') {
          throw fail('demo_only', 'テスト用ライフの補充は使えません。ライフはGameBullで管理されています。');
        } else {
          if (!a || request.attemptId !== a.id) throw fail('attempt_changed', '参加中のステージが変わりました。');
          if (action === 'restart') {
            await this.start(a.stage);
          } else {
            let g = this.engine();
            if (g.won) throw fail('won', 'クリア済みです。次のステージに参加してください。');
            if (this.expired()) throw fail('time_exceeded', '制限時間を過ぎました。「やり直す」で新しい挑戦を始めてください。');
            if (action === 'move') {
              const d = request.direction;
              if (!Array.isArray(d) || d.length !== 2 || !DIRS.some(x => x[0] === d[0] && x[1] === d[1])) throw fail('bad_direction', '移動方向が正しくありません。');
              if (!g.move(d[0], d[1])) return this.state();
              this.keep(g);
              if (g.won) {
                a.clearBody = { sessionToken: a.token, playTimeMs: Math.max(0, Date.now() - a.startedAt) };
                this.recordBest(g); this.save();
                await this.sendClear();
              }
            } else if (action === 'undo') {
              if (!g.history.length) throw fail('no_history', '戻せる手がありません。');
              if (a.kind === 'PAID') await this.consumeLife();
              g.undo(); this.keep(g);
            } else throw fail('bad_action', '対応していない操作です。');
          }
        }
        this.revision++; this.applied.push(request.operationId); this.applied = this.applied.slice(-200);
        this.save();
        return this.state();
      } finally { this.busy = false; }
    }
  }

  window.GameBullAdapterFactory = async ({ companyId, levelSetVersion }) => {
    const adapter = new StanceStageAdapter({ companyId, levelSetVersion, levels: LEVELS, Engine: Sokoban });
    window.StanceGB = adapter; // read by gb/stance-hooks.js
    return adapter;
  };
})();
