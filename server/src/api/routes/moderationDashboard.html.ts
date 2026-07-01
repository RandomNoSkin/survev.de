import { GameObjectDefs } from "../../../../shared/defs/gameObjectDefs";
import { PassDefs } from "../../../../shared/defs/gameObjects/passDefs";
import {
    _allowedCrosshairs,
    _allowedEmotes,
    _allowedHealEffects,
    _allowedMeleeSkins,
    _allowedOutfits,
    _allowedDeathEffects,
} from "../../../../shared/defs/gameObjects/unlockDefs";
import { GameConfig } from "../../../../shared/gameConfig";
import { Config } from "../../config";

/** Per-pass XP curve (xp[i] = xp needed for level i+1) + cap, for client-side level derivation. */
const PASS_XP: Record<string, number[]> = Object.fromEntries(
    Object.entries(PassDefs).map(([k, v]) => [k, v.xp]),
);
const PASS_MAX_LEVEL = GameConfig.serverSettings.passMaxLevel;

/** Grantable cosmetics by category, embedded into the SPA for the account "Give" UI. */
const COSMETIC_CATALOG = {
    outfit: _allowedOutfits,
    melee: _allowedMeleeSkins,
    heal: _allowedHealEffects,
    emote: _allowedEmotes,
    deathEffect: _allowedDeathEffects,
    crosshair: _allowedCrosshairs,
};

/** type → readable name (from the game defs) for every grantable cosmetic. */
const COSMETIC_NAMES: Record<string, string> = {};
for (const types of Object.values(COSMETIC_CATALOG)) {
    for (const t of types) {
        COSMETIC_NAMES[t] = (GameObjectDefs[t] as { name?: string })?.name || t;
    }
}

/** HTML template for the moderation dashboard SPA. Served inline by Hono so auth is enforced server-side. */
export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Moderation Dashboard – survev.de</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:       #080810; --surface: #0f0f1e; --surface2: #14142a; --surface3: #1a1a34;
      --border:   #1e1e3a; --border2: #2a2a4a;
      --text:     #c8c8e0; --text-dim: #5a5a7a; --text-muted: #3a3a55;
      --blue:     #3355ee; --blue-dim: #0e1e55; --blue-t: #5577ff;
      --green:    #1a7a1a; --green-t: #44cc44; --green-dim: #0a2a0a;
      --orange:   #aa4400; --orange-t: #ff8833; --orange-dim: #2a1000;
      --red:      #aa1a1a; --red-t: #ff4444;   --red-dim: #1e0808;
      --yellow-t: #ffcc44;
    }
    html, body { height: 100vh; overflow: hidden; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; font-size: 13px; display: flex; flex-direction: column; }

    /* ── Top bar ── */
    #topbar {
      display: flex; align-items: center; gap: 16px; padding: 12px 24px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, #0c0c20 0%, var(--bg) 100%);
      flex-shrink: 0;
    }
    #topbar-title { font-size: 15px; font-weight: 700; color: #fff; letter-spacing: .5px; }
    #topbar-user  { margin-left: auto; color: var(--text-dim); font-size: 12px; }
    #live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green-t); display: inline-block; margin-right: 4px; box-shadow: 0 0 5px var(--green-t); }
    #live-dot.off { background: var(--text-muted); box-shadow: none; }

    /* ── Tabs ── */
    #tabs { display: flex; gap: 2px; padding: 0 24px; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .tab-btn {
      padding: 10px 20px; cursor: pointer; border: none; background: none;
      color: var(--text-dim); font-size: 13px; font-weight: 500; font-family: inherit;
      border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--blue-t); border-bottom-color: var(--blue-t); }

    /* ── Main area ── */
    #main { flex: 1; min-height: 0; position: relative; }
    .tab-pane { display: none; position: absolute; inset: 0; overflow-y: auto; padding: 20px 24px; }
    .tab-pane.active { display: block; }
    .tab-pane > * + * { margin-top: 14px; }

    /* ── Toolbar row ── */
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .toolbar input[type=text] {
      background: var(--surface2); border: 1px solid var(--border2); border-radius: 6px;
      color: var(--text); padding: 6px 10px; font-size: 12px; font-family: inherit;
      outline: none; flex: 1; min-width: 160px;
    }
    .toolbar input[type=text]:focus { border-color: var(--blue); }

    /* ── Sub-tabs (inside Tab 1) ── */
    .sub-tabs { display: flex; gap: 6px; }
    .sub-tab-btn {
      padding: 5px 14px; border-radius: 20px; border: 1px solid var(--border2);
      background: none; color: var(--text-dim); cursor: pointer; font-size: 12px; font-family: inherit;
    }
    .sub-tab-btn.active { background: var(--blue-dim); border-color: var(--blue); color: var(--blue-t); }

    /* ── Table ── */
    .data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .data-table th { background: var(--surface2); color: var(--text-dim); font-weight: 600; text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border2); }
    .data-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .data-table tr:hover td { background: var(--surface2); }
    .data-table .ip-link { cursor: pointer; color: var(--blue-t); text-decoration: underline; font-family: monospace; font-size: 11px; }
    .nav-link { color: var(--blue-t); text-decoration: underline; cursor: pointer; }
    tr.flash td { animation: flashrow 1.5s ease-out; }
    @keyframes flashrow { from { background: var(--blue-dim); } to { background: transparent; } }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; letter-spacing: .3px; }
    .badge-admin  { background: var(--orange-dim); color: var(--orange-t); border: 1px solid var(--orange); }
    .badge-self   { background: var(--green-dim);  color: var(--green-t);  border: 1px solid var(--green); }
    .badge-alive  { background: var(--green-dim);  color: var(--green-t);  }
    .badge-dead   { background: var(--red-dim);    color: var(--red-t);    }
    .badge-spec   { background: var(--surface3);   color: var(--text-dim); }
    .badge-perm   { background: var(--red-dim);    color: var(--red-t);    border: 1px solid var(--red); }
    .badge-temp   { background: var(--orange-dim); color: var(--orange-t); }
    .badge-disc   { background: var(--surface3);   color: var(--text-muted); border: 1px solid var(--border2); }

    /* ── Buttons ── */
    .btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 5px; border: none; cursor: pointer; font-size: 11px; font-family: inherit; font-weight: 600; transition: opacity .15s; }
    .btn:hover { opacity: .85; }
    .btn-red    { background: var(--red-dim);    color: var(--red-t);    border: 1px solid var(--red); }
    .btn-blue   { background: var(--blue-dim);   color: var(--blue-t);   border: 1px solid var(--blue); }
    .btn-green  { background: var(--green-dim);  color: var(--green-t);  border: 1px solid var(--green); }
    .btn-orange { background: var(--orange-dim); color: var(--orange-t); border: 1px solid var(--orange); }
    .btn-gray   { background: var(--surface3);   color: var(--text-dim); border: 1px solid var(--border2); }
    .btn-primary { background: var(--blue); color: #fff; }
    .btn-sm { padding: 3px 8px; font-size: 10px; }

    /* ── Cards (game list) ── */
    #server-list { display: flex; flex-direction: column; gap: 16px; }
    .region-block { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .region-header { background: var(--surface2); padding: 10px 14px; font-weight: 600; color: var(--text-dim); font-size: 12px; border-bottom: 1px solid var(--border); }
    .game-cards { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px; }
    .game-card {
      background: var(--surface2); border: 1px solid var(--border2); border-radius: 6px;
      padding: 10px 14px; cursor: pointer; min-width: 160px; transition: border-color .15s;
    }
    .game-card:hover { border-color: var(--blue); }
    .game-card.pinned { border-color: var(--yellow-t); }
    .game-card.selected { border-color: var(--blue-t); background: var(--blue-dim); }
    .game-card .gc-id    { font-size: 10px; color: var(--text-muted); font-family: monospace; margin-bottom: 4px; }
    .game-card .gc-mode  { font-size: 12px; font-weight: 600; }
    .game-card .gc-count { font-size: 11px; color: var(--text-dim); margin-top: 2px; }

    /* ── Game detail panel ── */
    #game-detail { background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; overflow: hidden; }
    #game-detail-header { background: var(--surface2); padding: 10px 14px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); }
    #game-detail-header .gd-id { font-family: monospace; font-size: 11px; color: var(--text-dim); }
    #game-actions { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--border); }
    #player-table-wrap { overflow-x: auto; }

    /* ── IP detail card ── */
    .detail-card { background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 16px; }
    .detail-card h3 { font-size: 13px; margin-bottom: 10px; color: var(--text-dim); }
    /* Collapsible account-detail cards: click the header to fold the body away. */
    #account-modal-body .detail-card[data-card] > h3 { cursor: pointer; user-select: none; }
    #account-modal-body .detail-card[data-card] > h3::before { content: '▾'; display: inline-block; width: 14px; color: var(--text-dim); }
    #account-modal-body .detail-card.collapsed[data-card] > h3::before { content: '▸'; }
    #account-modal-body .detail-card.collapsed[data-card] > h3 { margin-bottom: 0; }
    #account-modal-body .detail-card.collapsed[data-card] > *:not(h3) { display: none; }
    .kv-row { display: flex; gap: 8px; margin-bottom: 6px; font-size: 12px; }
    .kv-key { color: var(--text-dim); min-width: 90px; }
    .kv-val { color: var(--text); font-family: monospace; }

    /* ── Announce inline panel ── */
    #announce-panel {
      display: none; background: var(--surface3); border: 1px solid var(--border2);
      border-radius: 6px; padding: 10px 12px; gap: 8px; align-items: center; flex-wrap: wrap;
    }
    #announce-panel.open { display: flex; }
    #announce-input { flex: 1; min-width: 200px; background: var(--surface2); border: 1px solid var(--border2); border-radius: 5px; padding: 6px 10px; color: var(--text); font-family: inherit; font-size: 12px; outline: none; }
    #announce-input:focus { border-color: var(--blue); }

    /* ── Msg panel ── */
    #msg-panel { display: none; background: var(--surface3); border: 1px solid var(--border2); border-radius: 6px; padding: 10px 12px; gap: 8px; align-items: center; flex-wrap: wrap; }
    #msg-panel.open { display: flex; }
    #msg-target-label { font-size: 12px; color: var(--blue-t); font-weight: 600; }
    #msg-input { flex: 1; min-width: 200px; background: var(--surface2); border: 1px solid var(--border2); border-radius: 5px; padding: 6px 10px; color: var(--text); font-family: inherit; font-size: 12px; outline: none; }
    #msg-input:focus { border-color: var(--blue); }

    /* ── Ban comment threads ── */
    .comments-row > td { background: var(--surface2); padding: 10px 14px; }
    .ban-comments { display: flex; flex-direction: column; gap: 6px; }
    .ban-comment { font-size: 11px; }
    .ban-comment-meta { color: var(--text-dim); font-size: 10px; }
    .ban-comment-text { color: var(--text); margin-top: 2px; white-space: pre-wrap; }
    .ban-comment-input-row { display: flex; gap: 6px; margin-top: 4px; }
    .ban-comment-input {
      flex: 1; background: var(--surface); border: 1px solid var(--border2); border-radius: 5px;
      padding: 5px 8px; color: var(--text); font-family: inherit; font-size: 11px; outline: none;
    }
    .ban-comment-input:focus { border-color: var(--blue); }

    /* ── Global chat log ── */
    .chat-game-group { border: 1px solid var(--border2); border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
    .chat-game-header { background: var(--surface2); padding: 8px 12px; font-size: 11px; color: var(--text-dim); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .chat-game-header .gid { font-family: monospace; color: var(--blue-t); cursor: pointer; text-decoration: underline; }
    .chat-msg { display: flex; gap: 10px; padding: 5px 12px; font-size: 12px; border-top: 1px solid var(--border); cursor: pointer; }
    .chat-msg:hover { background: var(--surface2); }
    .chat-msg .t { color: var(--text-muted); font-size: 10px; white-space: nowrap; min-width: 122px; }
    .chat-msg .nm { min-width: 150px; color: var(--text); font-weight: 500; }
    .chat-msg .ch { font-size: 10px; font-weight: 600; min-width: 34px; }
    .chat-msg .mg { flex: 1; word-break: break-word; }
    .chat-msg .chat-ban-link { color: var(--red-t); font-size: 10px; font-weight: 600; cursor: pointer; text-decoration: underline; white-space: nowrap; align-self: center; }
    .chat-msg.highlight { background: rgba(88,166,255,0.20); box-shadow: inset 3px 0 0 var(--blue); }
    .chat-msg mark { background: var(--blue); color: #fff; border-radius: 2px; padding: 0 2px; }
    #chatlog-back { margin-bottom: 10px; }

    /* ── Sortable table headers ── */
    .sortable { cursor: pointer; user-select: none; }
    .sortable:hover { color: var(--text); }

    /* ── Empty / loading states ── */
    .empty { color: var(--text-muted); font-size: 12px; padding: 24px; text-align: center; }
    .loading { color: var(--text-dim); font-size: 12px; padding: 12px; text-align: center; }

    /* ── Toast ── */
    #toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface3); border: 1px solid var(--border2); border-radius: 6px; padding: 8px 14px; font-size: 12px; opacity: 0; transition: opacity .3s; pointer-events: none; z-index: 999; }
    #toast.show { opacity: 1; }
  </style>
</head>
<body>

<!-- ── Top bar ── -->
<div id="topbar">
  <span id="topbar-title">⬛ Moderation Dashboard</span>
  <span id="topbar-live"><span id="live-dot" class="off"></span><span id="live-label" style="font-size:11px;color:var(--text-muted)">Connecting…</span></span>
  <span id="topbar-user" style="margin-left:auto;color:var(--text-dim);font-size:12px;">Loading…</span>
</div>

<!-- ── Tabs ── -->
<div id="tabs">
  <button class="tab-btn active" data-tab="bans">Bans</button>
  <button class="tab-btn"        data-tab="lookup">IP / Player</button>
  <button class="tab-btn"        data-tab="servers">Live Servers</button>
  <button class="tab-btn"        data-tab="accounts">Accounts</button>
  <button class="tab-btn"        data-tab="chatlog">Chat Log</button>
  <button class="tab-btn"        data-tab="replays">Replays</button>
  <button class="tab-btn"        data-tab="xp">XP Gain</button>
  <button class="tab-btn"        data-tab="warnings">Warnings</button>
</div>

<div id="main">

  <!-- ════════════════ TAB 1: BANS ════════════════ -->
  <div id="tab-bans" class="tab-pane active">
    <div class="toolbar">
      <div class="sub-tabs">
        <button class="sub-tab-btn active" data-sub="ip">IP Bans</button>
        <button class="sub-tab-btn"        data-sub="account">Account Bans</button>
        <button class="sub-tab-btn"        data-sub="chat">Chat Bans</button>
      </div>
      <input type="text" id="ban-search" placeholder="Search by hash, name, reason…">
      <button class="btn btn-primary" id="ban-new-btn">+ New Ban</button>
    </div>

    <!-- IP-Bans table -->
    <div id="sub-ip">
      <table class="data-table">
        <thead><tr>
          <th>IP Hash</th><th>Reason</th><th>Banned By</th><th>Type</th><th>Expires</th><th>Actions</th>
        </tr></thead>
        <tbody id="ip-ban-tbody"><tr><td colspan="6" class="loading">Loading…</td></tr></tbody>
      </table>
    </div>

    <!-- Account-Bans table -->
    <div id="sub-account" style="display:none">
      <table class="data-table">
        <thead><tr>
          <th>Slug</th><th>Username</th><th>Reason</th><th>Banned By</th><th>Actions</th>
        </tr></thead>
        <tbody id="account-ban-tbody"><tr><td colspan="5" class="loading">Loading…</td></tr></tbody>
      </table>
    </div>

    <!-- Chat-Bans table -->
    <div id="sub-chat" style="display:none">
      <table class="data-table">
        <thead><tr>
          <th>IP Hash</th><th>Reason</th><th>Banned By</th><th>Type</th><th>Expires</th><th>Actions</th>
        </tr></thead>
        <tbody id="chat-ban-tbody"><tr><td colspan="6" class="loading">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- ════════════════ TAB 2: IP / PLAYER LOOKUP ════════════════ -->
  <div id="tab-lookup" class="tab-pane">
    <div class="toolbar">
      <input type="text" id="lookup-input" placeholder="Enter IP hash, player name or account slug…" style="max-width:420px">
      <button class="btn btn-primary" id="lookup-btn">Search</button>
    </div>
    <div id="lookup-result"></div>
    <!-- Recent players quick-access list, hidden when a search is active -->
    <div id="recent-block">
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;letter-spacing:.5px;">RECENT PLAYERS</div>
      <table class="data-table" id="recent-table">
        <thead><tr><th>Name</th><th>Slug</th><th>IP Hash</th><th>ISP</th><th>Region</th><th>Last seen</th></tr></thead>
        <tbody id="recent-tbody"><tr><td colspan="6" class="loading">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- ════════════════ TAB: GLOBAL CHAT LOG ════════════════ -->
  <div id="tab-chatlog" class="tab-pane">
    <div class="toolbar">
      <input type="text" id="chatlog-search" placeholder="Search all chat messages…" style="max-width:420px">
      <select id="chatlog-channel" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="">All channels</option>
        <option value="0">Public (ALL)</option>
        <option value="1">Team</option>
        <option value="2">Spectator</option>
      </select>
      <button class="btn btn-primary" id="chatlog-search-btn">Search</button>
      <button class="btn btn-gray" id="chatlog-clear-btn">Clear</button>
    </div>
    <div id="chatlog-container"><div class="loading">Loading…</div></div>
  </div>

  <!-- ════════════════ TAB: REPLAYS ════════════════ -->
  <div id="tab-replays" class="tab-pane">
    <div class="toolbar">
      <input type="text" id="replays-search" placeholder="Search by game id, map or player name…" style="max-width:420px">
      <input type="datetime-local" id="replays-date" title="Show games around this time"
        style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
      <select id="replays-window" title="Time window around the selected time"
        style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="30">±30 min</option>
        <option value="60">±1 h</option>
        <option value="180" selected>±3 h</option>
        <option value="360">±6 h</option>
        <option value="720">±12 h</option>
        <option value="day">Whole day</option>
      </select>
      <button class="btn btn-gray" id="replays-date-clear">✕ Date</button>
      <select id="replays-limit" title="How many games to show"
        style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="20" selected>Show 20</option>
        <option value="10">Show 10</option>
        <option value="50">Show 50</option>
        <option value="100">Show 100</option>
        <option value="all">Show all</option>
      </select>
      <button class="btn btn-gray" id="replays-refresh-btn">↻ Refresh</button>
    </div>
    <div id="replays-container"><div class="loading">Loading…</div></div>
  </div>

  <!-- ════════════════ TAB: XP GAIN ════════════════ -->
  <div id="tab-xp" class="tab-pane">
    <div class="toolbar">
      <span style="font-size:12px;color:var(--text-dim);">XP gained in</span>
      <select id="xp-window" title="Time window"
        style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="24h">Last 24 hours</option>
        <option value="7d" selected>Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </select>
      <button class="btn btn-gray" id="xp-refresh-btn">↻ Refresh</button>
      <span id="xp-hint" style="font-size:11px;color:var(--text-dim);">Top XP gainers — sudden spikes may indicate account boosting.</span>
    </div>
    <div id="xp-container"><div class="loading">Loading…</div></div>
  </div>

  <!-- ════════════════ TAB: WARNINGS ════════════════ -->
  <div id="tab-warnings" class="tab-pane">
    <div class="toolbar">
      <span style="font-size:12px;color:var(--text-dim);">Suspicious activity in</span>
      <select id="warnings-window" title="Time window"
        style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="24h" selected>Last 24 hours</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </select>
      <button class="btn btn-gray" id="warnings-refresh-btn">↻ Refresh</button>
      <span style="font-size:11px;color:var(--text-dim);">Heuristics — review before acting; not proof of cheating.</span>
    </div>
    <div id="warnings-container"><div class="loading">Loading…</div></div>
  </div>

  <!-- ════════════════ TAB 4: ACCOUNTS ════════════════ -->
  <div id="tab-accounts" class="tab-pane">
    <div class="toolbar">
      <input type="text" id="accounts-search" placeholder="Search by username or slug…">
      <label style="font-size:11px;color:var(--text-dim);display:flex;align-items:center;gap:4px;white-space:nowrap;">Created
        <input type="date" id="accounts-date-from" title="Created from (inclusive)"
          style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:5px 8px;font-family:inherit;font-size:12px;">
        <span style="color:var(--text-muted);">–</span>
        <input type="date" id="accounts-date-to" title="Created until (inclusive)"
          style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:5px 8px;font-family:inherit;font-size:12px;">
      </label>
      <button class="btn btn-gray" id="accounts-date-clear">✕ Date</button>
      <button class="btn btn-orange" id="reconcile-btn">⚡ Reconcile All Passes + Unlocks + Fries</button>
      <span id="reconcile-result" style="font-size:11px;color:var(--text-dim);"></span>
    </div>
    <table class="data-table" id="accounts-table">
      <thead><tr id="accounts-thead-row">
        <th>#</th>
        <th class="sortable" data-col="username">Username</th>
        <th>Slug</th>
        <th>Discord</th>
        <th style="white-space:nowrap">Created</th>
        <th>Last IP</th>
        <th>Flags</th>
        <th class="sortable" data-col="goldenFries" style="text-align:center;white-space:nowrap;">GP</th>
        <!-- pass-level columns injected by renderAccountsHeader() -->
      </tr></thead>
      <tbody id="accounts-tbody"><tr><td colspan="6" class="loading">Loading…</td></tr></tbody>
    </table>
  </div>

  <!-- ════════════════ TAB 3: LIVE SERVERS ════════════════ -->
  <div id="tab-servers" class="tab-pane">
    <!-- Global announcement (sent to ALL running games) -->
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-blue btn-sm" id="global-announce-open">📢 Announce to ALL games</button>
    </div>
    <div id="global-announce-panel" style="display:none;background:var(--surface3);border:1px solid var(--border2);border-radius:6px;padding:10px 12px;gap:8px;align-items:center;flex-wrap:wrap;">
      <input id="global-announce-input" type="text" placeholder="Message to all players in all games…" maxlength="200"
        style="flex:1;min-width:200px;background:var(--surface2);border:1px solid var(--border2);border-radius:5px;padding:6px 10px;color:var(--text);font-family:inherit;font-size:12px;outline:none;">
      <input id="global-announce-color" type="color" value="#ffffff" title="Message color"
        style="width:32px;height:26px;padding:1px;border-radius:4px;border:1px solid var(--border2);background:var(--surface2);cursor:pointer;">
      <button class="btn btn-blue btn-sm" id="global-announce-send">SEND</button>
      <button class="btn btn-gray btn-sm" id="global-announce-cancel">✕</button>
    </div>

    <div id="server-list"><div class="loading">Connecting to stream…</div></div>

    <!-- Game detail panel (shown when a game is clicked) -->
    <div id="game-detail" style="display:none">
      <div id="game-detail-header">
        <span class="gd-id" id="gd-game-id"></span>
        <span class="gd-mode" id="gd-mode"></span>
        <button class="btn btn-gray btn-sm" id="gd-close-btn" style="margin-left:auto">✕ Close</button>
      </div>

      <!-- Game-level action buttons -->
      <div id="game-actions">
        <button class="btn btn-green  btn-sm" id="ga-verify">VERIFY LOBBY</button>
        <button class="btn btn-red    btn-sm" id="ga-unverify">UNVERIFY LOBBY</button>
        <button class="btn btn-orange btn-sm" id="ga-freeze">FREEZE</button>
        <button class="btn btn-gray   btn-sm" id="ga-unfreeze">UNFREEZE</button>
        <button class="btn btn-blue   btn-sm" id="ga-announce-open">ANNOUNCEMENT</button>
        <label style="display:flex;align-items:center;gap:6px;margin-left:auto;font-size:11px;color:var(--text-dim);cursor:pointer;">
          <input type="checkbox" id="show-disconnected" onchange="renderPlayers()">
          Show disconnected
        </label>
      </div>

      <!-- Announcement input panel (all-players) -->
      <div id="announce-panel" style="margin: 0 14px 10px;">
        <input id="announce-input" type="text" placeholder="Message to all players…" maxlength="200">
        <input id="announce-color" type="color" value="#ffffff" title="Message color" style="width:32px;height:26px;padding:1px;border-radius:4px;border:1px solid var(--border2);background:var(--surface2);cursor:pointer;">
        <button class="btn btn-blue btn-sm" id="ga-announce-send">SEND</button>
        <button class="btn btn-gray btn-sm" id="ga-announce-cancel">✕</button>
      </div>

      <!-- Direct-message panel (per-player) -->
      <div id="msg-panel" style="margin: 0 14px 10px;">
        <span>MSG to:</span>
        <span id="msg-target-label"></span>
        <input id="msg-input" type="text" placeholder="Message…" maxlength="200">
        <input id="msg-color" type="color" value="#44aaff" title="Message color" style="width:32px;height:26px;padding:1px;border-radius:4px;border:1px solid var(--border2);background:var(--surface2);cursor:pointer;">
        <button class="btn btn-blue btn-sm" id="msg-send-btn">SEND</button>
        <button class="btn btn-gray btn-sm" id="msg-cancel-btn">✕</button>
      </div>

      <!-- Player list -->
      <div id="player-table-wrap">
        <table class="data-table" id="player-table">
          <thead><tr>
            <th>Name</th><th>IP Hash</th><th>Kills</th><th>Assists</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody id="player-tbody"><tr><td colspan="6" class="loading">Loading…</td></tr></tbody>
        </table>
      </div>

      <!-- Live chat + kill feed panel -->
      <div id="game-feed-panel" style="margin:10px 14px 0;border:1px solid var(--border2);border-radius:6px;overflow:hidden;">
        <div style="background:var(--surface2);padding:6px 12px;font-size:11px;font-weight:700;color:var(--text-dim);letter-spacing:.5px;">LIVE CHAT &amp; KILL FEED</div>
        <div id="game-feed-list" style="max-height:200px;overflow-y:auto;padding:6px 10px;display:flex;flex-direction:column;gap:3px;font-size:12px;"></div>
        <div style="display:flex;gap:6px;padding:6px 10px;border-top:1px solid var(--border);">
          <input id="chat-send-input" type="text" maxlength="150" placeholder="Send message to game chat…"
            style="flex:1;background:var(--surface);border:1px solid var(--border2);border-radius:4px;padding:5px 8px;color:var(--text);font-family:inherit;font-size:12px;outline:none;">
          <button class="btn btn-blue btn-sm" id="chat-send-btn">SEND</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ── Toast notification ── -->
<div id="toast"></div>

<!-- ── New-ban modal ── -->
<div id="ban-modal" style="display:none;position:fixed;inset:0;background:#00000088;z-index:100;align-items:center;justify-content:center;">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:10px;padding:20px;width:360px;display:flex;flex-direction:column;gap:12px;">
    <div style="font-weight:700;font-size:14px;">Create New Ban</div>
    <div style="display:flex;flex-direction:column;gap:10px;font-size:12px;">
      <div>
        <div style="color:var(--text-dim);margin-bottom:4px;">Type</div>
        <select id="modal-ban-type" onchange="onBanTypeChange()" style="width:100%;background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:4px;padding:6px 8px;font-family:inherit;font-size:12px;">
          <option value="ip">IP Ban</option>
          <option value="account">Account Ban</option>
          <option value="chat">Chat Ban</option>
        </select>
      </div>
      <div>
        <div style="color:var(--text-dim);margin-bottom:4px;">Target <span id="modal-target-hint" style="color:var(--text-muted)">(IP hash)</span></div>
        <input id="modal-ban-target" type="text" style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;" placeholder="ip-hash or account-slug">
      </div>
      <div>
        <div style="color:var(--text-dim);margin-bottom:4px;">Reason</div>
        <input id="modal-ban-reason" type="text" style="width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;">
      </div>
      <!-- Duration fields – hidden for Account Bans (no expiry in DB) -->
      <div id="modal-duration-block">
        <div style="color:var(--text-dim);margin-bottom:4px;">Duration (days)</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <input id="modal-ban-days" type="number" value="7" min="1" style="width:80px;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;">
          <label style="display:flex;align-items:center;gap:6px;color:var(--text-dim);cursor:pointer;">
            <input id="modal-ban-perm" type="checkbox" onchange="document.getElementById('modal-ban-days').disabled=this.checked">
            Permanent
          </label>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
      <button class="btn btn-gray" id="modal-cancel-btn">Cancel</button>
      <button class="btn btn-red"  id="modal-confirm-btn">Ban</button>
    </div>
  </div>
</div>

<!-- ── Account detail modal ── -->
<div id="account-modal" style="display:none;position:fixed;inset:0;background:#000000aa;z-index:120;align-items:flex-start;justify-content:center;overflow-y:auto;padding:28px 12px;">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:10px;width:820px;max-width:100%;padding:18px;display:flex;flex-direction:column;gap:14px;">
    <div style="display:flex;align-items:center;gap:10px;">
      <div id="account-modal-title" style="font-weight:700;font-size:15px;color:#fff;">Account</div>
      <button class="btn btn-gray btn-sm" id="account-modal-close" style="margin-left:auto;">✕ Close</button>
    </div>
    <div id="account-modal-body"><div class="loading">Loading…</div></div>
  </div>
</div>

<script>
// ═══════════════════════════════════════════════════════════════════════════
// Moderation Dashboard – client-side logic
//
// Live updates are driven by a single SSE stream (/moderation/api/events).
// The server pushes events whenever data changes:
//   "bans"    → full ban list (on every ban/unban action)
//   "servers" → regions + game list (every 8 s server-side)
//   "players" → player list of the watched game (every 3 s server-side)
//
// The client never polls — it only reacts to push events.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// Base URL of the game client (Vite dev server in dev, same origin in prod) — used to open spectate tabs.
const CLIENT_URL = ${JSON.stringify(Config.oauthRedirectURI)};
// Grantable cosmetics by category (for the account-detail "Give" UI)
const COSMETIC_CATALOG = ${JSON.stringify(COSMETIC_CATALOG)};
// type → readable cosmetic name
const COSMETIC_NAMES = ${JSON.stringify(COSMETIC_NAMES)};
const cosmeticName = (t) => COSMETIC_NAMES[t] || t;
// Pass XP curves, for deriving the level from XP live in the account editor
const PASS_XP = ${JSON.stringify(PASS_XP)};
const PASS_MAX_LEVEL = ${JSON.stringify(PASS_MAX_LEVEL)};
function passLevelFromXp(passType, xp) {
  const arr = PASS_XP[passType];
  if (!arr || !arr.length) return 0;
  let remaining = xp, level = 1;
  while (level < PASS_MAX_LEVEL) {
    const need = arr[(level - 1 < arr.length) ? level - 1 : arr.length - 1];
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  return level;
}
function updateLvlFromXp(pt) {
  const xp = parseFloat(document.getElementById('xp-xp-' + pt).value) || 0;
  document.getElementById('xp-lvl-' + pt).value = passLevelFromXp(pt, xp);
}

// ── State ──────────────────────────────────────────────────────────────────
let currentAdminId   = '';    // own userId (for "YOU" badge + hide self-buttons)
let currentAdminSlug = '';    // own slug (shown as sender in announcements)
let activeGameRegion = '';    // region of the selected game
let activeGameId     = '';    // id of the selected game
let activeGameVerified = false; // verified-only state of the selected game
let msgTargetName    = '';    // player being DM'd
let bansData = { ipBans: [], accountBans: [], chatBans: [] };
let serverData = { regions: [] };
let activeServerRegion = null; // region whose games are shown in the Live Servers tab
let currentPlayers = [];

// Single SSE connection – reconnected when switching to server tab or selecting a game
let evtSource = null;

// ── Utilities ──────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('/moderation' + path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error ?? j.message ?? JSON.stringify(j); } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const get  = (path)       => api('GET',  path);
const post = (path, body) => api('POST', path, body);

function toast(msg, err) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = err ? 'var(--red)' : 'var(--green)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

function fmtDate(d) {
  if (!d) return '–';
  return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── Cross-navigation links ──────────────────────────────────────────────────
// Every cross-reference (span, table row, card or button) carries data-nav="<deep
// link hash>". A single delegated capture-phase handler drives it: plain left-click
// routes in-page; Ctrl/Cmd/Shift-click and middle-click open the same view in a new
// browser tab (the boot router resolves the hash there).
function hLookup(qv)          { return 'view=lookup&q=' + encodeURIComponent(qv); }
function hChatGame(gid, msg)  { return 'view=chatgame&gameId=' + encodeURIComponent(gid) + (msg != null ? '&msg=' + encodeURIComponent(msg) : ''); }
function hAccount(slug)       { return 'view=account&slug=' + encodeURIComponent(slug); }
function hReplays(qv)         { return 'view=replays&q=' + encodeURIComponent(qv); }
function hXpUser(userId, win) { return 'view=xpuser&userId=' + encodeURIComponent(userId) + (win ? '&window=' + encodeURIComponent(win) : ''); }

// Inline cross-link (styled span). labelHtml is already-escaped HTML.
function navLink(hash, labelHtml, opts) {
  opts = opts || {};
  const cls   = 'nav-link' + (opts.cls ? ' ' + opts.cls : '');
  const style = opts.style ? ' style="' + opts.style + '"' : '';
  const title = opts.title ? ' title="' + esc(opts.title) + '"' : '';
  return '<span class="' + cls + '" data-nav="' + esc(hash) + '"' + style + title + '>' + labelHtml + '</span>';
}

function navGo(hash, newTab) {
  if (newTab) window.open(location.pathname + '#' + hash, '_blank');
  else routeFromHash(hash);
}

// Capture phase so it runs before the element's own onclick and can suppress the
// in-page handler when a new tab is requested.
function navHandle(e, forceNewTab) {
  const navEl = e.target.closest('[data-nav]');
  if (!navEl) return;
  // A nested control WITHOUT its own data-nav (ban / +GP / spectate, inputs) keeps its click.
  const ctrl = e.target.closest('button, input, select, textarea, .chat-ban-link');
  if (ctrl && ctrl !== navEl && !ctrl.hasAttribute('data-nav') && navEl.contains(ctrl)) return;
  e.preventDefault();
  e.stopPropagation();
  navGo(navEl.dataset.nav, forceNewTab || e.ctrlKey || e.metaKey || e.shiftKey);
}
document.addEventListener('click', (e) => navHandle(e, false), true);
document.addEventListener('auxclick', (e) => { if (e.button === 1) navHandle(e, true); }, true);

// Applies a deep-link hash (from a nav element, or from the address bar on load).
function routeFromHash(h) {
  const q = (h || '').replace(/^#/, '');
  if (!q) return;
  const p = new URLSearchParams(q);
  const view = p.get('view');
  if (view === 'lookup') {
    const val = p.get('q') || '';
    switchTab('lookup');
    if (val) { document.getElementById('lookup-input').value = val; doLookup(val); }
  } else if (view === 'chatgame') {
    const gameId = p.get('gameId');
    const msg = p.get('msg');
    if (gameId) focusChatMessage(gameId, msg != null && msg !== '' ? Number(msg) : null);
    else switchTab('chatlog');
  } else if (view === 'account') {
    switchTab('accounts');
    const slug = p.get('slug');
    if (slug) openAccountDetail(slug);
  } else if (view === 'replays') {
    const el = document.getElementById('replays-search');
    if (el) el.value = p.get('q') || '';
    switchTab('replays');
  } else if (view === 'xpuser') {
    const win = p.get('window');
    if (win) { const sel = document.getElementById('xp-window'); if (sel) sel.value = win; }
    switchTab('xp');
    const userId = p.get('userId');
    if (userId) loadXpUser(userId);
  }
}

function ipLink(hash) {
  return navLink(hLookup(hash), esc(hash.slice(0, 12)) + '…', { cls: 'ip-link', title: hash });
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── SSE connection ─────────────────────────────────────────────────────────

function setLiveStatus(connected) {
  document.getElementById('live-dot').className   = connected ? '' : 'off';
  document.getElementById('live-label').textContent = connected ? 'Live' : 'Disconnected';
  document.getElementById('live-label').style.color = connected ? 'var(--green-t)' : 'var(--text-muted)';
}

/**
 * Opens (or re-opens) the SSE stream.
 * Pass region + gameId to also receive "players" events for that game.
 * Omit them to receive only "bans" and "servers" events.
 */
function connectSSE(region, gameId) {
  if (evtSource) { evtSource.close(); evtSource = null; }

  const params = new URLSearchParams();
  if (region) params.set('region', region);
  if (gameId)  params.set('gameId', gameId);

  evtSource = new EventSource('/moderation/api/events?' + params.toString());

  evtSource.addEventListener('bans', (e) => {
    bansData = JSON.parse(e.data);
    renderBans();
  });

  evtSource.addEventListener('servers', (e) => {
    serverData = JSON.parse(e.data);
    renderServers();
  });

  evtSource.addEventListener('players', (e) => {
    currentPlayers = JSON.parse(e.data).players ?? [];
    renderPlayers();
  });

  evtSource.addEventListener('feed', (e) => {
    const { entries = [] } = JSON.parse(e.data);
    const list = document.getElementById('game-feed-list');
    if (!list) return;
    for (const entry of entries) {
      const div = document.createElement('div');
      div.innerHTML = feedEntryHtml(entry);
      list.prepend(div.firstChild);
    }
    // Cap feed display at 100 entries
    while (list.children.length > 100) list.removeChild(list.lastChild);
  });

  evtSource.onopen  = () => setLiveStatus(true);
  evtSource.onerror = () => {
    setLiveStatus(false);
    // Browser auto-reconnects EventSource; we just update the indicator
  };
}

function closeSSE() {
  if (evtSource) { evtSource.close(); evtSource = null; }
  setLiveStatus(false);
}

// ── Tab switching ──────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => {
    const active = p.id === 'tab-' + name;
    p.classList.toggle('active', active);
    p.style.display = active ? 'block' : 'none';
  });

  if (name === 'servers') {
    connectSSE(null, null);
  } else if (name === 'bans') {
    connectSSE(null, null);
  } else if (name === 'lookup') {
    closeSSE();
    // Show the recent-players list when entering the tab
    document.getElementById('lookup-result').innerHTML = '';
    document.getElementById('recent-block').style.display = '';
    document.getElementById('lookup-input').value = '';
    loadRecent();
  } else if (name === 'accounts') {
    closeSSE();
    loadAccounts();
  } else if (name === 'chatlog') {
    closeSSE();
    // Skip when focusChatMessage drove the switch — it loads a focused view itself.
    if (!chatlogFocusing) loadGlobalChatLog(document.getElementById('chatlog-search').value.trim());
  } else if (name === 'replays') {
    closeSSE();
    loadReplays();
  } else if (name === 'xp') {
    closeSSE();
    loadXpGain();
  } else if (name === 'warnings') {
    closeSSE();
    loadWarnings();
  } else {
    closeSSE();
  }
}

document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// Initial tab visibility
document.querySelectorAll('.tab-pane').forEach(p => { p.style.display = p.classList.contains('active') ? 'block' : 'none'; });

// ── Sub-tab switching (inside Bans tab) ────────────────────────────────────

function switchSub(name) {
  document.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.sub === name));
  ['ip','account','chat'].forEach(s => {
    const el = document.getElementById('sub-' + s);
    if (el) el.style.display = s === name ? '' : 'none';
  });
}
document.querySelectorAll('.sub-tab-btn').forEach(b => b.addEventListener('click', () => switchSub(b.dataset.sub)));

// ═══════════════════════════════════════════════════════════════════════════
// TAB – REPLAYS (per-player POV recordings, browse + open in the game client)
// ═══════════════════════════════════════════════════════════════════════════

const TEAM_MODE_LABEL = { 1: 'Solo', 2: 'Duo', 4: 'Squad' };
let replaysData = [];   // [{ regionId, recordings: [...] }]

async function loadReplays() {
  const container = document.getElementById('replays-container');
  container.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await get('/api/replays');
    replaysData = data.regions ?? [];
    renderReplays();
  } catch (e) {
    container.innerHTML = '<div class="empty">Failed to load replays.</div>';
  }
}

function renderReplays() {
  const container = document.getElementById('replays-container');
  const q = document.getElementById('replays-search').value.trim().toLowerCase();

  // Optional date/time window: keep recordings whose startTs falls near the entered time.
  const dateVal = document.getElementById('replays-date').value;
  const target = dateVal ? Date.parse(dateVal) : NaN;
  let lo = -Infinity, hi = Infinity;
  if (!isNaN(target)) {
    const win = document.getElementById('replays-window').value;
    if (win === 'day') {
      const d = new Date(target);
      lo = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      hi = lo + 24 * 60 * 60 * 1000;
    } else {
      const ms = Number(win) * 60 * 1000;
      lo = target - ms;
      hi = target + ms;
    }
  }

  // Flatten region → games, filtered by the search box + (optional) time window.
  const games = [];
  for (const region of replaysData) {
    for (const rec of (region.recordings ?? [])) {
      const hay = (rec.gameId + ' ' + rec.mapName + ' ' +
        (rec.players ?? []).map(p => p.playerName).join(' ')).toLowerCase();
      if (q && !hay.includes(q)) continue;
      if (rec.startTs < lo || rec.startTs > hi) continue;
      games.push({ regionId: region.regionId, rec });
    }
  }
  // With a time set, surface the games closest to it first; otherwise newest first.
  if (!isNaN(target)) {
    games.sort((a, b) => Math.abs(a.rec.startTs - target) - Math.abs(b.rec.startTs - target));
  } else {
    games.sort((a, b) => b.rec.startTs - a.rec.startTs);
  }

  if (!games.length) {
    container.innerHTML = isNaN(target)
      ? '<div class="empty">No recordings found.</div>'
      : '<div class="empty">No recordings near that time.</div>';
    return;
  }

  // Only render a capped number of games so the tab stays light (the DOM per game
  // is a full POV table). Default 20; "all" removes the cap.
  const limitVal = document.getElementById('replays-limit').value;
  const limit = limitVal === 'all' ? Infinity : (Number(limitVal) || 20);
  const shown = games.slice(0, limit);
  const header = shown.length < games.length
    ? \`<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">Showing \${shown.length} of \${games.length} games — raise the limit to see more.</div>\`
    : \`<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">Showing \${games.length} game\${games.length === 1 ? '' : 's'}.</div>\`;

  container.innerHTML = header + shown.map(({ regionId, rec }) => {
    const mode = TEAM_MODE_LABEL[rec.teamMode] || ('Mode ' + rec.teamMode);
    const dur = Math.round((rec.durationMs || 0) / 1000);
    const durStr = dur >= 60 ? (Math.floor(dur / 60) + 'm ' + (dur % 60) + 's') : (dur + 's');
    const fmtAlive = (s) => s == null ? '—' : (s >= 60 ? (Math.floor(s / 60) + 'm ' + (s % 60) + 's') : (s + 's'));
    const rows = (rec.players ?? []).map(p => \`
      <tr>
        <td>\${esc(p.playerName)}</td>
        <td>\${p.kills ?? '—'}</td>
        <td>\${p.damageDealt ?? '—'}</td>
        <td>\${p.damageTaken ?? '—'}</td>
        <td>\${fmtAlive(p.timeAlive)}</td>
        <td style="color:var(--text-dim)">\${(p.bytes / 1024 / 1024).toFixed(1)} MB</td>
        <td><button class="btn btn-blue btn-sm" onclick="watchReplay('\${esc(regionId)}','\${esc(rec.gameId)}',\${p.playerId})">▶ Watch</button></td>
      </tr>\`).join('');
    return \`
      <div class="chat-game-group">
        <div class="chat-game-header">
          <span class="gid">\${esc(rec.gameId)}</span>
          <span>\${esc(regionId)}</span>
          <span>\${esc(rec.mapName)} · \${mode}</span>
          <span>\${durStr}</span>
          <span style="margin-left:auto">\${fmtDate(rec.startTs)}</span>
        </div>
        <table class="data-table" style="margin:0">
          <thead><tr><th>Player POV</th><th>Kills</th><th>Dmg dealt</th><th>Dmg taken</th><th>Alive</th><th>Size</th><th>Action</th></tr></thead>
          <tbody>\${rows || '<tr><td colspan="7" class="empty">No POVs.</td></tr>'}</tbody>
        </table>
      </div>\`;
  }).join('');
}

/** Mints a game-scoped replay token and opens the client in replay mode (with an initial POV). */
async function watchReplay(region, gameId, playerId) {
  try {
    const params = new URLSearchParams({ region, gameId });
    const { token } = await get('/api/replays/token?' + params.toString());
    if (!token) { toast('Failed to get replay token', true); return; }
    const url = CLIENT_URL + '/?replay=' + encodeURIComponent(token) + '&pov=' + playerId;
    window.open(url, '_blank');
  } catch (e) {
    toast('Failed to open replay: ' + e.message, true);
  }
}

document.getElementById('replays-refresh-btn').addEventListener('click', loadReplays);
document.getElementById('replays-search').addEventListener('input', renderReplays);
document.getElementById('replays-date').addEventListener('change', renderReplays);
document.getElementById('replays-window').addEventListener('change', renderReplays);
document.getElementById('replays-limit').addEventListener('change', renderReplays);
document.getElementById('replays-date-clear').addEventListener('click', () => {
  document.getElementById('replays-date').value = '';
  renderReplays();
});

// ═══════════════════════════════════════════════════════════════════════════
// TAB – XP GAIN (recent XP-gain leaderboard to spot account boosting)
// ═══════════════════════════════════════════════════════════════════════════

// Leaderboard and per-user detail both render into #xp-container; a token guards
// against a slower request overwriting a newer view (e.g. detail opened right after
// the tab's leaderboard load started).
let xpLoadToken = 0;

async function loadXpGain() {
  const container = document.getElementById('xp-container');
  const token = ++xpLoadToken;
  container.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const win = document.getElementById('xp-window').value;
    const data = await get('/api/xp-gain?window=' + encodeURIComponent(win));
    if (token !== xpLoadToken) return;
    renderXpGain(data.users ?? []);
  } catch (e) {
    if (token !== xpLoadToken) return;
    container.innerHTML = '<div class="empty">Failed to load XP gain.</div>';
  }
}

async function loadXpUser(userId) {
  const container = document.getElementById('xp-container');
  const token = ++xpLoadToken;
  container.innerHTML = '<div class="loading">Loading player games…</div>';
  try {
    const win = document.getElementById('xp-window').value;
    const data = await get('/api/xp-gain/user/' + encodeURIComponent(userId) + '?window=' + encodeURIComponent(win));
    if (token !== xpLoadToken) return;
    renderXpUserDetail(data);
  } catch (e) {
    if (token !== xpLoadToken) return;
    container.innerHTML = '<div class="empty">Failed to load player XP detail.</div>';
  }
}

// Tiny inline-SVG sparkline of per-day XP (highlights the peak day → sudden spikes).
function xpSparkline(spark) {
  if (!spark || spark.length === 0) return '';
  const w = 120, h = 24, pad = 2;
  const xs = spark.map(p => p.xp);
  const max = Math.max(...xs, 1);
  const n = spark.length;
  const coord = (i) => {
    const x = n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1);
    const y = h - pad - (xs[i] / max) * (h - 2 * pad);
    return [x, y];
  };
  const pts = spark.map((_, i) => coord(i).map(v => v.toFixed(1)).join(',')).join(' ');
  let mi = 0; for (let i = 1; i < n; i++) if (xs[i] > xs[mi]) mi = i;
  const [px, py] = coord(mi);
  const dot = '<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="2" fill="var(--red-t, #f66)"/>';
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="vertical-align:middle">' +
    '<polyline points="' + pts + '" fill="none" stroke="var(--blue-t)" stroke-width="1.5"/>' + dot + '</svg>';
}

function renderXpGain(users) {
  const container = document.getElementById('xp-container');
  if (!users.length) { container.innerHTML = '<div class="empty">No XP gained in this window.</div>'; return; }
  const win = document.getElementById('xp-window').value;
  const maxXp = Math.max(...users.map(u => u.xpGained), 1);
  const rows = users.map((u, i) => {
    const pct = Math.max(2, (u.xpGained / maxXp) * 100);
    const label = esc(u.username || u.slug || '(guest / unlinked)');
    const nameCell = u.slug
      ? \`\${navLink(hLookup(u.slug), label, { title: 'Look up account' })} <span style="color:var(--text-muted);font-size:10px;">(\${esc(u.slug)})</span>\`
      : \`<span style="color:var(--text-muted)">\${label}</span>\`;
    const bannedBadge = u.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
    return \`<tr data-nav="\${esc(hXpUser(u.userId, win))}" style="cursor:pointer" title="Show this player's games">
      <td style="color:var(--text-dim)">#\${i + 1}</td>
      <td>\${nameCell}\${bannedBadge}</td>
      <td style="min-width:180px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="flex:1;background:var(--surface3);border-radius:3px;height:10px;overflow:hidden;">
            <div style="width:\${pct}%;height:100%;background:var(--blue-t);"></div>
          </div>
          <strong style="white-space:nowrap;">\${u.xpGained.toLocaleString()}</strong>
        </div>
      </td>
      <td>\${u.games}</td>
      <td>\${u.xpPerGame.toLocaleString()}</td>
      <td>\${xpSparkline(u.spark)}</td>
    </tr>\`;
  }).join('');
  container.innerHTML = \`
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">Click a player to see their individual games and details.</div>
    <table class="data-table">
      <thead><tr><th>#</th><th>Account</th><th>XP gained</th><th>Games</th><th>XP / game</th><th>Trend</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
}

// Short m:ss / s duration, shared by the XP drill-down (replays render has its own local copy).
function fmtSecs(s) { if (s == null) return '–'; return s >= 60 ? (Math.floor(s / 60) + 'm ' + (s % 60) + 's') : (s + 's'); }

// Bigger inline-SVG chart: one bar per game over the window. Bars carry data-game so
// a click jumps to (and flashes) that game's row — "click a moment, see the game".
function xpUserChart(games) {
  if (!games.length) return '<div class="empty">No games in this window.</div>';
  const W = 760, H = 190, pad = 26;
  const max = Math.max(...games.map(g => g.xp), 1);
  const n = games.length;
  const bw = (W - 2 * pad) / n;
  const bars = games.map((g, i) => {
    const h = Math.max(1, (g.xp / max) * (H - 2 * pad));
    const x = pad + i * bw;
    const y = H - pad - h;
    const w = Math.max(1, bw - 2);
    const title = fmtDate(g.createdAt) + ' · ' + g.mapName + ' · ' + g.xp.toLocaleString() + ' XP';
    return '<rect data-game="' + esc(g.gameId) + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1" fill="var(--blue-t)" style="cursor:pointer"><title>' + esc(title) + '</title></rect>';
  }).join('');
  const axis = '<line x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" stroke="var(--border2)"/>';
  const labels =
    '<text x="' + pad + '" y="' + (H - 8) + '" fill="var(--text-muted)" font-size="10">' + esc(fmtDate(games[0].createdAt)) + '</text>' +
    '<text x="' + (W - pad) + '" y="' + (H - 8) + '" fill="var(--text-muted)" font-size="10" text-anchor="end">' + esc(fmtDate(games[n - 1].createdAt)) + '</text>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-height:210px;background:var(--surface);border:1px solid var(--border2);border-radius:8px;">' + axis + bars + labels + '</svg>';
}

function renderXpUserDetail(data) {
  const container = document.getElementById('xp-container');
  const games = data.games ?? [];
  const label = esc(data.username || data.slug || data.userId);
  const banned = data.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
  const lookup = data.slug ? ' · ' + navLink(hLookup(data.slug), 'look up account', { title: 'Open IP / Player lookup' }) : '';
  const rows = games.slice().reverse().map(g => {
    const mode = TEAM_MODE_LABEL[g.teamMode] || ('Mode ' + g.teamMode);
    return \`<tr id="xpgame-\${esc(g.gameId)}">
      <td style="white-space:nowrap;font-size:11px;">\${fmtDate(g.createdAt)}</td>
      <td>\${esc(g.region || '–')}</td>
      <td>\${esc(g.mapName)} · \${mode}</td>
      <td>\${g.kills}</td>
      <td>\${g.damage}</td>
      <td>\${g.rank}</td>
      <td>\${fmtSecs(g.timeAlive)}</td>
      <td><strong>\${g.xp.toLocaleString()}</strong></td>
      <td style="white-space:nowrap;">\${navLink(hReplays(g.gameId), 'replay', { title: 'Find the replay of this game' })} · \${navLink(hChatGame(g.gameId, null), 'chat', { title: 'Open this game\\'s chat' })}</td>
    </tr>\`;
  }).join('');
  container.innerHTML = \`
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
      <button class="btn btn-gray btn-sm" id="xp-back-btn">← Back</button>
      <div style="font-size:15px;font-weight:600;">\${label}\${banned}</div>
      <div style="font-size:12px;color:var(--text-dim);">\${data.slug ? '(' + esc(data.slug) + ')' : ''}\${lookup}</div>
      <div style="margin-left:auto;font-size:12px;color:var(--text-dim);">\${games.length} games · <strong style="color:var(--text)">\${(data.totalXp || 0).toLocaleString()}</strong> XP in \${esc(data.window)}</div>
    </div>
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">Click a bar to jump to that game.</div>
    \${xpUserChart(games)}
    <div style="margin-top:14px;">
      <table class="data-table">
        <thead><tr><th>Time</th><th>Region</th><th>Map · Mode</th><th>Kills</th><th>Dmg</th><th>Rank</th><th>Alive</th><th>XP</th><th>Game</th></tr></thead>
        <tbody>\${rows || '<tr><td colspan="9" class="empty">No games.</td></tr>'}</tbody>
      </table>
    </div>\`;
  document.getElementById('xp-back-btn').addEventListener('click', loadXpGain);
}

// Scroll to and briefly flash a game row (from a chart bar click).
function highlightGame(gameId) {
  const row = document.getElementById('xpgame-' + gameId);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // restart the animation if the same bar is clicked again
  row.classList.add('flash');
}
// Chart bars carry data-game; delegate their clicks (they have no data-nav).
document.addEventListener('click', (e) => {
  const bar = e.target.closest('[data-game]');
  if (bar) highlightGame(bar.dataset.game);
});

document.getElementById('xp-refresh-btn').addEventListener('click', loadXpGain);
document.getElementById('xp-window').addEventListener('change', loadXpGain);

// ═══════════════════════════════════════════════════════════════════════════
// TAB – WARNINGS (heuristic suspicious-behaviour feed)
// ═══════════════════════════════════════════════════════════════════════════

async function loadWarnings() {
  const container = document.getElementById('warnings-container');
  container.innerHTML = '<div class="loading">Analyzing…</div>';
  try {
    const win = document.getElementById('warnings-window').value;
    const data = await get('/api/warnings?window=' + encodeURIComponent(win));
    renderWarnings(data);
  } catch (e) {
    container.innerHTML = '<div class="empty">Failed to load warnings.</div>';
  }
}

// Comma-joined name list, truncated so a shared IP with dozens of alts stays readable.
function warnNames(names) {
  const list = names || [];
  const shown = list.slice(0, 6).map(n => esc(n)).join(', ');
  return list.length > 6
    ? shown + ' <span style="color:var(--text-muted)">+' + (list.length - 6) + ' more</span>'
    : (shown || '–');
}

function warnSection(title, count, hint, tableHtml) {
  return \`<div style="margin-bottom:18px;">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">
        <span style="font-size:13px;font-weight:600;">\${esc(title)}</span>
        <span class="badge \${count ? 'badge-perm' : 'badge-alive'}">\${count}</span>
        <span style="font-size:11px;color:var(--text-dim);">\${esc(hint)}</span>
      </div>
      \${tableHtml}
    </div>\`;
}

function renderWarnings(data) {
  const container = document.getElementById('warnings-container');
  const win = document.getElementById('warnings-window').value;
  const sharedGames = data.sharedIpGames ?? [];
  const sharedAcc = data.sharedIpAccounts ?? [];
  const spikes = data.xpSpikes ?? [];

  // 1) Same IP appearing multiple times in one game.
  const gRows = sharedGames.map(g => \`<tr>
      <td>\${ipLink(g.ip)}</td>
      <td><strong>\${g.joins}</strong></td>
      <td>\${g.accounts}</td>
      <td style="max-width:340px;">\${warnNames(g.names)}</td>
      <td>\${esc(g.region || '–')}</td>
      <td style="white-space:nowrap;">\${navLink(hReplays(g.gameId), 'replay', { title: 'Find the replay' })} · \${navLink(hChatGame(g.gameId, null), 'chat', { title: 'Open game chat' })}</td>
      <td style="white-space:nowrap;">\${fmtDate(g.lastSeen)}</td>
    </tr>\`).join('');
  const gTable = sharedGames.length
    ? \`<table class="data-table"><thead><tr><th>IP</th><th>Joins</th><th>Accounts</th><th>Names</th><th>Region</th><th>Game</th><th>Last seen</th></tr></thead><tbody>\${gRows}</tbody></table>\`
    : '<div class="empty">No games with a repeated IP.</div>';

  // 2) Same IP used by many distinct accounts.
  const aRows = sharedAcc.map(a => \`<tr>
      <td>\${ipLink(a.ip)}</td>
      <td>\${esc(a.isp || '–')}</td>
      <td><strong>\${a.accounts}</strong></td>
      <td>\${a.joins}</td>
      <td style="max-width:340px;">\${warnNames(a.names)}</td>
      <td style="white-space:nowrap;">\${fmtDate(a.lastSeen)}</td>
    </tr>\`).join('');
  const aTable = sharedAcc.length
    ? \`<table class="data-table"><thead><tr><th>IP</th><th>ISP</th><th>Accounts</th><th>Joins</th><th>Names</th><th>Last seen</th></tr></thead><tbody>\${aRows}</tbody></table>\`
    : '<div class="empty">No IP shared across many accounts.</div>';

  // 3) XP spikes.
  const sRows = spikes.map((s, i) => {
    const label = esc(s.username || s.slug || s.userId);
    const nameCell = s.slug
      ? \`\${navLink(hLookup(s.slug), label, { title: 'Look up account' })} <span style="color:var(--text-muted);font-size:10px;">(\${esc(s.slug)})</span>\`
      : \`<span style="color:var(--text-muted)">\${label}</span>\`;
    const banned = s.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
    const reasons = (s.reasons || []).map(r => \`<span class="badge badge-disc">\${esc(r)}</span>\`).join(' ');
    return \`<tr data-nav="\${esc(hXpUser(s.userId, win))}" style="cursor:pointer" title="Show this player's games">
      <td style="color:var(--text-dim)">#\${i + 1}</td>
      <td>\${nameCell}\${banned}</td>
      <td><strong>\${s.xpGained.toLocaleString()}</strong></td>
      <td>\${s.games}</td>
      <td>\${s.xpPerGame.toLocaleString()}</td>
      <td>\${reasons}</td>
    </tr>\`;
  }).join('');
  const sTable = spikes.length
    ? \`<table class="data-table"><thead><tr><th>#</th><th>Account</th><th>XP gained</th><th>Games</th><th>XP/game</th><th>Flags</th></tr></thead><tbody>\${sRows}</tbody></table>\`
    : '<div class="empty">No XP spikes detected.</div>';

  container.innerHTML =
    warnSection('Same IP joined a game multiple times', sharedGames.length,
      'Players or spectators sharing one IP in the same game (multi-boxing / alts / ghosting).', gTable) +
    warnSection('IP used by many accounts', sharedAcc.length,
      'One IP behind several accounts in this window (possible alt farm).', aTable) +
    warnSection('XP spikes', spikes.length,
      'Abnormal game volume or XP/game (grinding / botting / feeding). Click a row for their games.', sTable);
}

document.getElementById('warnings-refresh-btn').addEventListener('click', loadWarnings);
document.getElementById('warnings-window').addEventListener('change', loadWarnings);

// ═══════════════════════════════════════════════════════════════════════════
// TAB 1 – BAN MANAGEMENT (receives live "bans" events via SSE)
// ═══════════════════════════════════════════════════════════════════════════

function renderBans() {
  const q = document.getElementById('ban-search').value.toLowerCase();
  renderIpBans(q);
  renderAccountBans(q);
  renderChatBans(q);
}

function renderIpBans(q) {
  const tbody = document.getElementById('ip-ban-tbody');
  const rows = bansData.ipBans.filter(b =>
    !q || b.encodedIp.includes(q) || (b.reason||'').toLowerCase().includes(q) || (b.bannedBy||'').toLowerCase().includes(q)
  );
  tbody.innerHTML = rows.length ? rows.map(b => \`
    <tr data-target="\${esc(b.encodedIp)}">
      <td>\${ipLink(b.encodedIp)}</td>
      <td>\${esc(b.reason||'–')}</td>
      <td>\${esc(b.bannedBy||'–')}</td>
      <td>\${b.permanent ? '<span class="badge badge-perm">PERMANENT</span>' : '<span class="badge badge-temp">TEMP</span>'}</td>
      <td>\${b.permanent ? '∞' : fmtDate(b.expiresIn)}</td>
      <td>
        <button class="btn btn-green btn-sm" onclick="unbanIp('\${esc(b.encodedIp)}')">Unban</button>
        <button class="btn btn-gray btn-sm" onclick="toggleBanComments('ip','\${esc(b.encodedIp)}', this)">💬</button>
      </td>
    </tr>
  \`).join('') : '<tr><td colspan="6" class="empty">No IP bans.</td></tr>';
  reopenComments('ip', tbody);
}

function renderAccountBans(q) {
  const tbody = document.getElementById('account-ban-tbody');
  const rows = bansData.accountBans.filter(b =>
    !q || b.slug.includes(q) || b.username.toLowerCase().includes(q) || (b.banReason||'').toLowerCase().includes(q)
  );
  tbody.innerHTML = rows.length ? rows.map(b => \`
    <tr data-target="\${esc(b.slug)}">
      <td>\${esc(b.slug)}</td>
      <td>\${esc(b.username)}</td>
      <td>\${esc(b.banReason||'–')}</td>
      <td>\${esc(b.bannedBy||'–')}</td>
      <td>
        <button class="btn btn-green btn-sm" onclick="unbanAccount('\${esc(b.slug)}')">Unban</button>
        <button class="btn btn-gray btn-sm" onclick="toggleBanComments('account','\${esc(b.slug)}', this)">💬</button>
      </td>
    </tr>
  \`).join('') : '<tr><td colspan="5" class="empty">No account bans.</td></tr>';
  reopenComments('account', tbody);
}

function renderChatBans(q) {
  const tbody = document.getElementById('chat-ban-tbody');
  const rows = bansData.chatBans.filter(b =>
    !q || b.encodedIp.includes(q) || (b.reason||'').toLowerCase().includes(q) || (b.bannedBy||'').toLowerCase().includes(q)
  );
  tbody.innerHTML = rows.length ? rows.map(b => \`
    <tr data-target="\${esc(b.encodedIp)}">
      <td>\${ipLink(b.encodedIp)}</td>
      <td>\${esc(b.reason||'–')}</td>
      <td>\${esc(b.bannedBy||'–')}</td>
      <td>\${b.permanent ? '<span class="badge badge-perm">PERMANENT</span>' : '<span class="badge badge-temp">TEMP</span>'}</td>
      <td>\${b.permanent ? '∞' : fmtDate(b.expiresIn)}</td>
      <td>
        <button class="btn btn-green btn-sm" onclick="unbanChat('\${esc(b.encodedIp)}')">Unban</button>
        <button class="btn btn-gray btn-sm" onclick="toggleBanComments('chat','\${esc(b.encodedIp)}', this)">💬</button>
      </td>
    </tr>
  \`).join('') : '<tr><td colspan="6" class="empty">No chat bans.</td></tr>';
  reopenComments('chat', tbody);
}

// ── Ban comment threads (expandable per-row) ──────────────────────────────

const openBanComments = new Set(); // keys: "type::target"

/** Re-opens comment threads that were open before the table was re-rendered. */
function reopenComments(type, tbody) {
  for (const row of tbody.querySelectorAll('tr[data-target]')) {
    const key = type + '::' + row.dataset.target;
    if (openBanComments.has(key)) insertCommentsRow(type, row.dataset.target, row);
  }
}

function insertCommentsRow(type, target, row) {
  const tr = document.createElement('tr');
  tr.className = 'comments-row';
  const td = document.createElement('td');
  td.colSpan = row.children.length;
  td.innerHTML = '<div class="loading">Loading comments…</div>';
  tr.appendChild(td);
  row.after(tr);
  loadBanComments(type, target, td);
}

/** Toggles the comment thread below a ban row. */
function toggleBanComments(type, target, btn) {
  const row = btn.closest('tr');
  const key = type + '::' + target;
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains('comments-row')) {
    existing.remove();
    openBanComments.delete(key);
    return;
  }
  openBanComments.add(key);
  insertCommentsRow(type, target, row);
}

async function loadBanComments(type, target, td) {
  try {
    const data = await get('/api/ban-comments/' + type + '/' + encodeURIComponent(target));
    renderBanComments(type, target, td, data.comments ?? []);
  } catch {
    td.innerHTML = '<div class="empty">Failed to load comments.</div>';
  }
}

function renderBanComments(type, target, td, comments) {
  td.innerHTML = \`
    <div class="ban-comments">
      \${comments.length ? comments.map(c => \`
        <div class="ban-comment">
          <span class="ban-comment-meta">\${fmtDate(c.createdAt)} – <strong>\${esc(c.createdBy)}</strong></span>
          <div class="ban-comment-text">\${esc(c.comment)}</div>
        </div>
      \`).join('') : '<div class="empty" style="padding:4px 0;">No comments yet.</div>'}
      <div class="ban-comment-input-row">
        <input type="text" class="ban-comment-input" placeholder="Add a comment…" maxlength="500">
        <button class="btn btn-blue btn-sm">Add</button>
      </div>
    </div>
  \`;
  const input  = td.querySelector('.ban-comment-input');
  const addBtn = td.querySelector('.ban-comment-input-row button');
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      await post('/api/ban-comments', { type, target, comment: text });
      await loadBanComments(type, target, td);
    } catch (e) { toast('Error adding comment', true); }
  };
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

document.getElementById('ban-search').addEventListener('input', renderBans);

async function unbanIp(ip) {
  try { await post('/api/unban/ip', { ip }); toast('IP entbannt'); }
  catch (e) { toast('Fehler beim Entbannen', true); }
}
async function unbanAccount(slug) {
  try { await post('/api/unban/account', { slug }); toast('Account entbannt'); }
  catch (e) { toast('Fehler beim Entbannen', true); }
}
async function unbanChat(ip) {
  try { await post('/api/unban/chat', { ip }); toast('Chat-Ban aufgehoben'); }
  catch (e) { toast('Fehler beim Entbannen', true); }
}

// ── New-ban modal ──────────────────────────────────────────────────────────

// Show/hide duration block + update target hint based on selected ban type
function onBanTypeChange() {
  const type = document.getElementById('modal-ban-type').value;
  const durationBlock = document.getElementById('modal-duration-block');
  const targetHint    = document.getElementById('modal-target-hint');
  durationBlock.style.display = type === 'account' ? 'none' : '';
  targetHint.textContent = type === 'account' ? '(account slug)' : '(IP hash)';
}

const banModal = document.getElementById('ban-modal');

document.getElementById('ban-new-btn').addEventListener('click', () => {
  // Reset form on open (no kick target)
  delete banModal.dataset.kickTarget;
  document.getElementById('modal-ban-target').value = '';
  document.getElementById('modal-ban-reason').value = '';
  document.getElementById('modal-ban-days').value   = '7';
  document.getElementById('modal-ban-days').disabled = false;
  document.getElementById('modal-ban-perm').checked = false;
  document.getElementById('modal-ban-type').value   = 'ip';
  onBanTypeChange();
  banModal.style.display = 'flex';
});

document.getElementById('modal-cancel-btn').addEventListener('click', () => { banModal.style.display = 'none'; });

document.getElementById('modal-confirm-btn').addEventListener('click', async () => {
  const type   = document.getElementById('modal-ban-type').value;
  const target = document.getElementById('modal-ban-target').value.trim();
  const reason = document.getElementById('modal-ban-reason').value.trim();
  const perm   = document.getElementById('modal-ban-perm').checked;
  const days   = perm ? 36500 : (parseInt(document.getElementById('modal-ban-days').value) || 7);
  if (!target) return toast('Please specify a target!', true);
  try {
    if (type === 'ip')      await post('/api/ban/ip',      { ip: target, reason, duration: days, permanent: perm });
    if (type === 'account') await post('/api/ban/account', { slug: target, reason });
    if (type === 'chat')    await post('/api/ban/chat',    { ip: target, reason, duration: days, permanent: perm });

    // If opened from player list: also ban account + kick the player
    const kickTarget = banModal.dataset.kickTarget;
    if (kickTarget) {
      delete banModal.dataset.kickTarget;
      await post('/api/ban/account', { slug: kickTarget, reason });
      await gameCmd({ action: 'kick', target: kickTarget });
    }

    toast('Ban created ✓');
    banModal.style.display = 'none';
  } catch (e) { toast('Error: ' + e.message, true); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TAB 2 – IP / PLAYER LOOKUP (plain REST, no SSE needed)
// ═══════════════════════════════════════════════════════════════════════════

function isIpHash(s) { return /^[0-9a-f]{64}$/.test(s); }

/** Loads and renders the recent-players quick-access table. */
async function loadRecent() {
  try {
    const data = await get('/api/recent');
    const tbody = document.getElementById('recent-tbody');
    const rows  = data.recent ?? [];
    tbody.innerHTML = rows.length ? rows.map(r => \`
      <tr style="cursor:pointer" data-nav="\${esc(hLookup(r.username))}" title="Look up this player">
        <td>\${navLink(hLookup(r.username), esc(r.username), { style: 'color:var(--blue-t)' })}</td>
        <td>\${r.slug ? esc(r.slug) : '<span style="color:var(--text-muted)">–</span>'}</td>
        <td>\${ipLink(r.encodedIp)}</td>
        <td>\${esc(r.isp || '–')}</td>
        <td>\${esc(r.region || '–')}</td>
        <td>\${fmtDate(r.createdAt)}</td>
      </tr>
    \`).join('') : '<tr><td colspan="6" class="empty">No recent players.</td></tr>';
  } catch { /* silently ignore */ }
}

async function doLookup(query) {
  const res = document.getElementById('lookup-result');
  // Hide the recent list while a result is displayed
  document.getElementById('recent-block').style.display = 'none';
  res.innerHTML = '<div class="loading">Searching…</div>';

  if (isIpHash(query)) {
    try { renderIpDetail(await get('/api/ip/' + encodeURIComponent(query)), res); }
    catch { res.innerHTML = '<div class="empty">No results found.</div>'; }
    return;
  }

  // Account slug? Show the account's names + IPs on the lookup view (instead of
  // jumping straight into the account-detail modal), so alt names / shared IPs are visible.
  try {
    const data = await get('/api/slug/' + encodeURIComponent(query));
    if (data && data.userId) {
      renderSlugDetail(data, res);
      return;
    }
  } catch { /* not an account slug — fall back to player-name lookup */ }

  try {
    renderPlayerDetail(await get('/api/player/' + encodeURIComponent(query)), res);
  } catch (e) { res.innerHTML = '<div class="empty">No results found.</div>'; }
}

function banTypeLabel(t) {
  return t === 'ip' ? 'IP' : t === 'account' ? 'ACCOUNT' : t === 'chat' ? 'CHAT' : esc(t);
}

// Inline "Ban History" card: from → until · by whom · reason · status.
// Used in both the player and IP detail views (data.banHistory from the API).
function renderBanHistory(history) {
  const inner = (!history || !history.length)
    ? '<div class="empty">No ban history.</div>'
    : \`<table class="data-table">
        <thead><tr><th>Type</th><th>From</th><th>Until</th><th>By</th><th>Reason</th><th>Status</th></tr></thead>
        <tbody>\${history.map(h => {
          const lifted = !!h.unbannedAt;
          const expired = !lifted && !h.permanent && h.expiresAt && new Date(h.expiresAt) <= new Date();
          const status = lifted ? 'LIFTED' : expired ? 'EXPIRED' : 'ACTIVE';
          const badge = status === 'ACTIVE' ? 'badge-perm' : status === 'LIFTED' ? 'badge-temp' : 'badge-disc';
          const until = lifted
            ? \`lifted \${fmtDate(h.unbannedAt)}\${h.unbannedBy ? ' by ' + esc(h.unbannedBy) : ''}\`
            : h.permanent ? 'permanent'
            : h.expiresAt ? fmtDate(h.expiresAt)
            : 'until lifted';
          return \`<tr>
            <td><span class="badge badge-disc">\${banTypeLabel(h.banType)}</span></td>
            <td style="white-space:nowrap;font-size:11px;">\${fmtDate(h.bannedAt)}</td>
            <td style="white-space:nowrap;font-size:11px;">\${until}</td>
            <td>\${esc(h.bannedBy || '–')}</td>
            <td>\${esc(h.reason || '–')}</td>
            <td><span class="badge \${badge}">\${status}</span></td>
          </tr>\`;
        }).join('')}</tbody>
      </table>\`;
  return \`<div class="detail-card" style="margin-top:12px;"><h3>Ban History</h3>\${inner}</div>\`;
}

function renderIpDetail(data, container) {
  const banInfo = data.banned
    ? \`<span class="badge badge-perm">BANNED</span> \${esc(data.banRecord?.reason || '')}\`
    : '<span class="badge badge-alive">Clean</span>';
  const rows = (data.accounts || []).map(a => {
    const isHistorical = a.source === 'historical';
    const sourceBadge = isHistorical
      ? '<span class="badge" style="background:var(--surface3);color:var(--text-muted);border:1px solid var(--border2)">HISTORICAL</span>'
      : '<span class="badge badge-alive">RECENT</span>';
    return \`<tr>
      <td>\${esc(a.username)} \${sourceBadge}</td>
      <td>\${a.slug ? esc(a.slug) : '<span style="color:var(--text-muted)">–</span>'}</td>
      <td>\${a.count ? a.count : '<span style="color:var(--text-muted)">–</span>'}</td>
      <td>\${esc(a.isp || '–')}</td>
      <td>\${esc(a.region || '–')}</td>
      <td>\${isHistorical ? '<span style="color:var(--text-muted)">via match history</span>' : fmtDate(a.createdAt)}</td>
    </tr>\`;
  }).join('');
  container.innerHTML = \`
    <div class="detail-card">
      <h3>IP Details</h3>
      <div class="kv-row"><span class="kv-key">Hash:</span><span class="kv-val">\${esc(data.hash)}</span></div>
      <div class="kv-row"><span class="kv-key">ISP:</span><span class="kv-val">\${esc(data.isp || 'Unknown')}</span></div>
      <div class="kv-row"><span class="kv-key">Ban status:</span><span>\${banInfo}</span></div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
        \${data.banned
          ? \`<button class="btn btn-green btn-sm" onclick="unbanIp('\${esc(data.hash)}')">Unban</button>\`
          : \`<button class="btn btn-red btn-sm" onclick="quickBanIp('\${esc(data.hash)}')">Ban IP</button>\`}
        <button class="btn btn-blue btn-sm" onclick="loadChatLog('\${esc(data.hash)}', 'ip', this)">💬 Chat History</button>
      </div>
      <div id="chat-log-panel" style="display:none;margin-top:10px;"></div>
    </div>
    \${renderBanHistory(data.banHistory)}
    <div style="margin-top:12px;">
      <table class="data-table">
        <thead><tr><th>Name</th><th>Slug</th><th>Uses</th><th>ISP</th><th>Region</th><th>Last seen</th></tr></thead>
        <tbody>\${rows || '<tr><td colspan="6" class="empty">No entries.</td></tr>'}</tbody>
      </table>
    </div>
  \`;
}

function renderPlayerDetail(data, container) {
  const rows = (data.ips || []).map(ip => \`
    <tr>
      <td>\${ipLink(ip.ip)}</td>
      <td>\${esc(ip.isp || '–')}</td>
      <td>\${esc(ip.region || '–')}</td>
      <td>\${ip.count ? ip.count : '<span style="color:var(--text-muted)">–</span>'}</td>
      <td>\${fmtDate(ip.lastSeen)}</td>
    </tr>
  \`).join('');
  container.innerHTML = \`
    <div class="detail-card">
      <h3>Player: <strong>\${esc(data.name)}</strong></h3>
      <p style="font-size:12px;color:var(--text-dim);margin-top:4px;">Known IPs – click a hash to see full details.</p>
      <div style="margin-top:8px;">
        <button class="btn btn-blue btn-sm" onclick="loadChatLog('\${esc(data.name)}', 'name', this)">💬 Chat History</button>
      </div>
    </div>
    <div id="chat-log-panel" style="display:none;margin-top:12px;"></div>
    \${renderBanHistory(data.banHistory)}
    <div style="margin-top:12px;">
      <table class="data-table">
        <thead><tr><th>IP Hash</th><th>ISP</th><th>Region</th><th>Uses</th><th>Last seen</th></tr></thead>
        <tbody>\${rows || '<tr><td colspan="5" class="empty">No IPs found.</td></tr>'}</tbody>
      </table>
    </div>
  \`;
}

// Account-slug lookup: every name + IP the account played under (stays on lookup view).
function renderSlugDetail(data, container) {
  const nameRows = (data.names || []).map(n => \`
    <tr>
      <td>\${esc(n.username)}</td>
      <td>\${n.count ? n.count : '<span style="color:var(--text-muted)">–</span>'}</td>
      <td>\${fmtDate(n.lastSeen)}</td>
    </tr>\`).join('');
  const ipRows = (data.ips || []).map(ip => \`
    <tr>
      <td>\${ipLink(ip.ip)}</td>
      <td>\${esc(ip.isp || '–')}</td>
      <td>\${esc(ip.region || '–')}</td>
      <td>\${ip.count ? ip.count : '<span style="color:var(--text-muted)">–</span>'}</td>
      <td>\${fmtDate(ip.lastSeen)}</td>
    </tr>\`).join('');
  container.innerHTML = \`
    <div class="detail-card">
      <h3>Account: <strong>\${esc(data.username || data.slug)}</strong></h3>
      <div class="kv-row"><span class="kv-key">Slug:</span><span class="kv-val">\${esc(data.slug)}</span></div>
      <p style="font-size:12px;color:var(--text-dim);margin-top:4px;">All names & IPs this account has played under — click an IP hash for full details.</p>
      <div style="margin-top:8px;">
        <button class="btn btn-blue btn-sm" data-nav="\${esc(hAccount(data.slug))}">Open full account detail</button>
      </div>
    </div>
    \${renderBanHistory(data.banHistory)}
    <div style="margin-top:12px;">
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;letter-spacing:.5px;">NAMES USED</div>
      <table class="data-table">
        <thead><tr><th>Name</th><th>Uses</th><th>Last seen</th></tr></thead>
        <tbody>\${nameRows || '<tr><td colspan="3" class="empty">No names found.</td></tr>'}</tbody>
      </table>
    </div>
    <div style="margin-top:12px;">
      <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;font-weight:600;letter-spacing:.5px;">IPS USED</div>
      <table class="data-table">
        <thead><tr><th>IP Hash</th><th>ISP</th><th>Region</th><th>Uses</th><th>Last seen</th></tr></thead>
        <tbody>\${ipRows || '<tr><td colspan="5" class="empty">No IPs found.</td></tr>'}</tbody>
      </table>
    </div>
  \`;
}

const CHANNEL_LABELS = ['ALL', 'TEAM', 'SPEC'];
const CHANNEL_COLORS = ['var(--text)', 'var(--green-t)', 'var(--text-dim)'];

async function loadChatLog(query, by, btn) {
  const panel = document.getElementById('chat-log-panel');
  if (panel.style.display !== 'none') { panel.style.display = 'none'; if(btn) btn.textContent = '💬 Chat History'; return; }
  panel.style.display = '';
  if(btn) btn.textContent = '💬 Hide Chat History';
  panel.innerHTML = '<div class="loading">Loading chat history…</div>';
  try {
    const data = await get('/api/chat/' + encodeURIComponent(query) + '?by=' + by);
    const msgs = data.messages ?? [];
    if (!msgs.length) { panel.innerHTML = '<div class="empty">No chat messages found.</div>'; return; }
    panel.innerHTML = \`
      <table class="data-table">
        <thead><tr><th>Time</th><th>Name</th><th>Channel</th><th>Message</th><th>Game</th></tr></thead>
        <tbody>\${msgs.map(m => \`<tr data-nav="\${esc(hChatGame(m.gameId, m.id))}" style="cursor:pointer" title="Open in Chat Log with context">
          <td style="white-space:nowrap;font-size:11px;">\${fmtDate(m.createdAt)}</td>
          <td>\${esc(m.username)}\${m.slug ? \` <span style="color:var(--text-muted);font-size:10px;">(\${esc(m.slug)})</span>\` : ''}</td>
          <td><span style="font-size:10px;font-weight:600;color:\${CHANNEL_COLORS[m.channel] ?? 'var(--text)'};">\${CHANNEL_LABELS[m.channel] ?? m.channel}</span></td>
          <td>\${esc(m.message)}</td>
          <td style="font-family:monospace;font-size:10px;color:var(--text-muted);">\${navLink(hChatGame(m.gameId, m.id), esc((m.gameId||'').slice(0,8)) + '…', { title: 'Open in Chat Log with context' })}</td>
        </tr>\`).join('')}</tbody>
      </table>
    \`;
  } catch { panel.innerHTML = '<div class="empty">Failed to load chat history.</div>'; }
}

// ── Global Chat Log tab ─────────────────────────────────────────────────────
// True while focusChatMessage drives the tab switch, so switchTab's auto-reload
// doesn't clobber the focused (single-game, context) view with the global list.
let chatlogFocusing = false;

function chatlogGroupByGame(messages) {
  const map = new Map();
  for (const m of messages) {
    const g = m.gameId || 'unknown';
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(m);
  }
  const groups = [...map.entries()].map(([gameId, msgs]) => {
    msgs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return { gameId, msgs, first: msgs[0].createdAt, last: msgs[msgs.length - 1].createdAt };
  });
  // most recently active game first
  groups.sort((a, b) => new Date(b.last) - new Date(a.last));
  return groups;
}

function chatlogHighlight(escapedText, search) {
  if (!search) return escapedText;
  const safe = search.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  try { return escapedText.replace(new RegExp('(' + safe + ')', 'gi'), '<mark>$1</mark>'); }
  catch { return escapedText; }
}

function chatlogMsgRow(m, search, highlightId) {
  const hl = (highlightId != null && m.id === highlightId) ? ' highlight' : '';
  const message = search ? chatlogHighlight(esc(m.message), search) : esc(m.message);
  const slug = m.slug ? \` <span style="color:var(--text-muted);font-size:10px;">(\${esc(m.slug)})</span>\` : '';
  // Clicking the name jumps to the player's IP (where they can be banned).
  const nameHtml = m.encodedIp
    ? navLink(hLookup(m.encodedIp), esc(m.username), { title: 'View IP / ban' })
    : esc(m.username);
  // Trailing chat-ban action (text link at the end of the row; opens the ban modal prefilled).
  const banBtn = m.encodedIp
    ? \`<a class="chat-ban-link" onclick="event.stopPropagation();quickBanChat('\${esc(m.encodedIp)}')" title="Chat-ban this IP">chat ban</a>\`
    : '';
  return \`<div class="chat-msg\${hl}" id="chatmsg-\${m.id}" data-nav="\${esc(hChatGame(m.gameId, m.id))}">
      <span class="t">\${fmtDate(m.createdAt)}</span>
      <span class="nm">\${nameHtml}\${slug}</span>
      <span class="ch" style="color:\${CHANNEL_COLORS[m.channel] ?? 'var(--text)'}">\${CHANNEL_LABELS[m.channel] ?? m.channel}</span>
      <span class="mg">\${message}</span>
      \${banBtn}
    </div>\`;
}

function chatlogRenderGroups(messages, search) {
  if (!messages.length) return '<div class="empty">No chat messages found.</div>';
  return chatlogGroupByGame(messages).map(g => \`
    <div class="chat-game-group">
      <div class="chat-game-header">
        \${navLink(hChatGame(g.gameId, null), esc(g.gameId.slice(0, 8)) + '…', { cls: 'gid', title: 'Open full game chat' })}
        <span>\${g.msgs.length} msg\${g.msgs.length === 1 ? '' : 's'}</span>
        <span>\${fmtDate(g.first)} – \${fmtDate(g.last)}</span>
      </div>
      \${g.msgs.map(m => chatlogMsgRow(m, search)).join('')}
    </div>\`).join('');
}

async function loadGlobalChatLog(search) {
  const cont = document.getElementById('chatlog-container');
  cont.innerHTML = '<div class="loading">Loading chat log…</div>';
  try {
    const channel = document.getElementById('chatlog-channel').value;
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (channel !== '') params.set('channel', channel);
    const qs = params.toString();
    const data = await get('/api/chatlog' + (qs ? ('?' + qs) : ''));
    const msgs = data.messages ?? [];
    const header = search
      ? \`<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">\${msgs.length} match\${msgs.length === 1 ? '' : 'es'} for "\${esc(search)}" — grouped by game</div>\`
      : '';
    cont.innerHTML = header + chatlogRenderGroups(msgs, search);
  } catch { cont.innerHTML = '<div class="empty">Failed to load chat log.</div>'; }
}

// Opens the full chat of one game and (optionally) highlights + scrolls to a
// specific message, so a message clicked anywhere is shown with its context.
async function focusChatMessage(gameId, messageId) {
  chatlogFocusing = true;
  switchTab('chatlog');
  chatlogFocusing = false;

  const cont = document.getElementById('chatlog-container');
  cont.innerHTML = '<div class="loading">Loading game chat…</div>';
  try {
    const data = await get('/api/chatlog/game/' + encodeURIComponent(gameId));
    const msgs = data.messages ?? [];
    cont.innerHTML = \`
      <button class="btn btn-gray btn-sm" id="chatlog-back" onclick="loadGlobalChatLog(document.getElementById('chatlog-search').value.trim())">← Back to all chats</button>
      <div class="chat-game-group">
        <div class="chat-game-header"><span class="gid">\${esc(gameId.slice(0, 8))}…</span><span>\${msgs.length} msg\${msgs.length === 1 ? '' : 's'}</span><span>full game chat</span></div>
        \${msgs.map(m => chatlogMsgRow(m, '', messageId)).join('') || '<div class="empty" style="padding:10px">No messages in this game.</div>'}
      </div>\`;
    if (messageId != null) {
      const el = document.getElementById('chatmsg-' + messageId);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch { cont.innerHTML = '<div class="empty">Failed to load game chat.</div>'; }
}

document.getElementById('chatlog-search-btn').addEventListener('click', () => loadGlobalChatLog(document.getElementById('chatlog-search').value.trim()));
document.getElementById('chatlog-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadGlobalChatLog(e.target.value.trim()); });
document.getElementById('chatlog-clear-btn').addEventListener('click', () => { document.getElementById('chatlog-search').value = ''; loadGlobalChatLog(''); });
document.getElementById('chatlog-channel').addEventListener('change', () => loadGlobalChatLog(document.getElementById('chatlog-search').value.trim()));

function quickBanIp(hash) {
  // Pre-fill the ban modal and open it
  document.getElementById('modal-ban-type').value   = 'ip';
  document.getElementById('modal-ban-target').value = hash;
  document.getElementById('modal-ban-reason').value = '';
  document.getElementById('modal-ban-days').value   = '7';
  document.getElementById('modal-ban-days').disabled = false;
  document.getElementById('modal-ban-perm').checked = false;
  onBanTypeChange();
  banModal.style.display = 'flex';
}

function quickBanChat(hash) {
  // Pre-fill the ban modal as a chat ban (reason/duration editable before confirm).
  delete banModal.dataset.kickTarget;
  document.getElementById('modal-ban-type').value   = 'chat';
  document.getElementById('modal-ban-target').value = hash;
  document.getElementById('modal-ban-reason').value = '';
  document.getElementById('modal-ban-days').value   = '7';
  document.getElementById('modal-ban-days').disabled = false;
  document.getElementById('modal-ban-perm').checked = false;
  onBanTypeChange();
  banModal.style.display = 'flex';
}

document.getElementById('lookup-btn').addEventListener('click', () => {
  const q = document.getElementById('lookup-input').value.trim();
  if (q) { doLookup(q); } else {
    // Empty search → restore recent list
    document.getElementById('lookup-result').innerHTML = '';
    document.getElementById('recent-block').style.display = '';
  }
});
document.getElementById('lookup-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const q = e.target.value.trim(); if (q) doLookup(q); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TAB 3 – LIVE SERVERS (receives "servers" + "players" events via SSE)
// ═══════════════════════════════════════════════════════════════════════════

function selectServerRegion(regionId) {
  activeServerRegion = regionId;
  renderServers();
}

function renderServers() {
  const list = document.getElementById('server-list');
  const regions = serverData.regions || [];
  if (!regions.length) { list.innerHTML = '<div class="empty">No regions found.</div>'; return; }

  // Keep the selected region across the frequent SSE re-renders; fall back to the first.
  if (!regions.some(r => r.regionId === activeServerRegion)) {
    activeServerRegion = regions[0].regionId;
  }

  // ── Region tabs (each shows active game + player counts) ──
  const tabsHtml = regions.map(region => {
    const games = (region.games || []).filter(g => !g.stopped);
    const playerSum = games.reduce((n, g) => n + (g.playerCount || 0), 0);
    const active = region.regionId === activeServerRegion;
    return \`<button class="sub-tab-btn \${active ? 'active' : ''}" onclick="selectServerRegion('\${esc(region.regionId)}')">
      <b>\${esc(region.regionId.toUpperCase())}</b>
      <span style="color:var(--text-muted);font-weight:400;"> · \${games.length} games · \${playerSum} players</span>
    </button>\`;
  }).join('');

  // ── Games of the active region ──
  const region = regions.find(r => r.regionId === activeServerRegion);
  const games = (region.games || []).filter(g => !g.stopped);
  const cardsHtml = games.length ? games.map((g) => {
    const isSelected = activeGameId === g.id;
    return \`<div class="game-card \${isSelected ? 'selected' : ''}" data-region="\${esc(region.regionId)}" data-id="\${esc(g.id)}" onclick="selectGame('\${esc(region.regionId)}','\${esc(g.id)}')">
      <div class="gc-id">\${esc(g.id.slice(0,8))}…</div>
      <div class="gc-mode">Mode \${esc(String(g.teamMode || '?'))}</div>
      <div class="gc-count">\${g.playerCount ?? '?'} players</div>
      <div style="margin-top:6px;">
        <button class="btn btn-blue btn-sm" style="width:100%" onclick="event.stopPropagation();spectateGame('\${esc(region.regionId)}','\${esc(g.id)}')">👁 SPECTATE</button>
      </div>
      <div style="margin-top:4px;">
        <button class="btn btn-red btn-sm" style="width:100%" onclick="event.stopPropagation();killGame('\${esc(region.regionId)}','\${esc(g.id)}')">✕ KILL</button>
      </div>
    </div>\`;
  }).join('') : '<div class="empty">No running games.</div>';

  const verifyBtn = region.verifiedOnly
    ? \`<button class="btn btn-red btn-sm" style="margin-left:auto" onclick="setServerVerified('\${esc(region.regionId)}', false)">UNVERIFY SERVER</button>\`
    : \`<button class="btn btn-green btn-sm" style="margin-left:auto" onclick="setServerVerified('\${esc(region.regionId)}', true)">VERIFY SERVER</button>\`;

  list.innerHTML = \`
    <div class="sub-tabs" style="flex-wrap:wrap">\${tabsHtml}</div>
    <div class="region-block" id="region-games">
      <div class="region-header" style="display:flex;align-items:center;">Region: \${esc(region.regionId)}\${verifyBtn}</div>
      <div class="game-cards">\${cardsHtml}</div>
    </div>\`;
}

/** Opens the game client in a new tab and auto-spectates the given game. */
async function spectateGame(region, gameId) {
  try {
    const data = await get('/api/game/' + encodeURIComponent(region) + '/' + encodeURIComponent(gameId) + '/spectate-token');
    const matchData = data?.res?.[0];
    if (!matchData) { toast('Could not get spectate token', true); return; }
    // CLIENT_URL may be a different origin (e.g. dev: dashboard on :8000, client on :3000),
    // so pass the match data via URL param instead of sessionStorage.
    const url = CLIENT_URL + '/?spectate=' + encodeURIComponent(JSON.stringify(matchData));
    window.open(url, '_blank');
    toast('Opening spectator view…');
  } catch (e) { toast('Spectate failed', true); }
}

/** Force-stops a running game immediately (private games that are empty/stuck). */
async function killGame(region, gameId) {
  if (!confirm('Force-stop this game?')) return;
  try {
    await post('/api/game/' + encodeURIComponent(region) + '/' + encodeURIComponent(gameId) + '/cmd', { action: 'stop' });
    toast('Game stopped');
    refreshData();
  } catch (e) { toast('Kill failed', true); }
}

/** Selects a game and reconnects SSE with the gameId so player events start flowing. */
function feedEntryHtml(entry) {
  if (entry.channel === -1) {
    const parts = (entry.message || '').split('|');
    const victim = parts[0] ?? '?';
    const weapon = parts[1] ?? '';
    return \`<div class="feed-kill" style="color:var(--red-t)">💀 <b>\${esc(entry.username||'?')}</b> killed <b>\${esc(victim)}</b> [\${esc(weapon)}]</div>\`;
  }
  if (entry.channel === -2) {
    const parts = (entry.message || '').split('|');
    const victim = parts[0] ?? '?';
    const weapon = parts[1] ?? '';
    return \`<div class="feed-down" style="color:var(--orange-t)">💥 <b>\${esc(entry.username||'?')}</b> knocked <b>\${esc(victim)}</b> [\${esc(weapon)}]</div>\`;
  }
  return \`<div class="feed-chat" style="color:var(--blue-t)">💬 <b>\${esc(entry.username||'?')}</b>: \${esc(entry.message||'')}</div>\`;
}

async function loadGameFeedHistory(region, gameId) {
  const list = document.getElementById('game-feed-list');
  if (!list) return;
  list.innerHTML = '';
  try {
    const data = await get('/api/game/' + encodeURIComponent(region) + '/' + encodeURIComponent(gameId) + '/chat');
    const entries = data.messages ?? [];
    for (const entry of entries) {
      const div = document.createElement('div');
      div.innerHTML = feedEntryHtml(entry);
      list.appendChild(div.firstChild);
    }
  } catch { /* non-critical */ }
}

function selectGame(region, gameId) {
  activeGameRegion = region;
  activeGameId     = gameId;
  document.getElementById('gd-game-id').textContent = gameId.slice(0,8) + '…';
  document.getElementById('game-detail').style.display = '';
  closeAnnouncePanel();
  closeMsgPanel();
  const gameData = serverData.regions.find(r => r.regionId === region)?.games?.find(g => g.id === gameId);
  updateVerifyButtons(gameData?.verifiedOnly ?? false);
  currentPlayers = [];
  document.getElementById('player-tbody').innerHTML = '<tr><td colspan="6" class="loading">Lade…</td></tr>';

  // Load existing feed history immediately
  loadGameFeedHistory(region, gameId);

  // Re-open SSE with the selected gameId – server now streams player data too
  connectSSE(region, gameId);

  // Highlight selected card
  renderServers();
}

function renderPlayers() {
  // Pin admin's own game card if admin is in this game
  const adminInGame = currentPlayers.some(p => p.userId === currentAdminId);
  document.querySelectorAll('.game-card[data-id="' + activeGameId + '"]')
    .forEach(el => el.classList.toggle('pinned', adminInGame));

  const showDisc = document.getElementById('show-disconnected')?.checked ?? false;
  const visiblePlayers = showDisc
    ? currentPlayers
    : currentPlayers.filter(p => !p.disconnected);

  const tbody = document.getElementById('player-tbody');
  tbody.innerHTML = visiblePlayers.length ? visiblePlayers.map(p => {
    // Status badges: alive/dead + spectator (can be combined); disconnected overrides
    const aliveBadge = p.disconnected
      ? '<span class="badge badge-disc">DISCONNECTED</span>'
      : p.isSpectator
        ? ''
        : p.alive
          ? '<span class="badge badge-alive">ALIVE</span>'
          : '<span class="badge badge-dead">DEAD</span>';
    const specBadge  = !p.disconnected && p.isSpectator ? '<span class="badge badge-spec">SPECTATOR</span>' : '';
    const adminBadge = p.isAdmin ? '<span class="badge badge-admin">ADMIN</span>' : '';
    const isSelf     = p.userId === currentAdminId;
    const selfBadge  = isSelf ? '<span class="badge badge-self">YOU</span>' : '';
    // No kick/ban buttons for self or already-disconnected players
    const actionBtns = (isSelf || p.disconnected) ? '' : \`
        <button class="btn btn-red  btn-sm" onclick="gameCmd({action:'kick',target:'\${esc(p.username)}'})">KICK</button>
        <button class="btn btn-red  btn-sm" style="background:var(--red-dim)" onclick="quickBanPlayer('\${esc(p.username)}','\${esc(p.encodedIp)}')">BAN</button>\`;
    return \`<tr style="\${p.disconnected ? 'opacity:.5' : ''}">
      <td>\${esc(p.username)} \${adminBadge} \${selfBadge}</td>
      <td>\${ipLink(p.encodedIp)}</td>
      <td>\${p.kills ?? 0}</td>
      <td>\${p.assists ?? 0}</td>
      <td>\${aliveBadge}\${specBadge}</td>
      <td>\${actionBtns}
        \${!p.disconnected ? \`<button class="btn btn-blue btn-sm" onclick="openMsg('\${esc(p.username)}')">MSG</button>\` : ''}
      </td>
    </tr>\`;
  }).join('') : '<tr><td colspan="6" class="empty">No players.</td></tr>';
}

// ── Game-level commands ────────────────────────────────────────────────────

async function gameCmd(cmd) {
  if (!activeGameId) return;
  try {
    await post('/api/game/' + encodeURIComponent(activeGameRegion) + '/' + encodeURIComponent(activeGameId) + '/cmd', cmd);
    toast('Befehl gesendet ✓');
  } catch (e) { toast('Fehler: ' + e.message, true); }
}

// Global announce (all games across all regions)
document.getElementById('global-announce-open').addEventListener('click', () => {
  const panel = document.getElementById('global-announce-panel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});
document.getElementById('global-announce-cancel').addEventListener('click', () => {
  document.getElementById('global-announce-panel').style.display = 'none';
});
async function sendGlobalAnnounce() {
  const text  = document.getElementById('global-announce-input').value.trim();
  const color = document.getElementById('global-announce-color').value;
  if (!text) return;
  try {
    await post('/api/servers/announce', { text, color, sender: currentAdminSlug });
    toast('Announcement sent to all games ✓');
    document.getElementById('global-announce-input').value = '';
    document.getElementById('global-announce-panel').style.display = 'none';
  } catch (e) { toast('Error sending announcement', true); }
}
document.getElementById('global-announce-send').addEventListener('click', sendGlobalAnnounce);
document.getElementById('global-announce-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendGlobalAnnounce(); });

function updateVerifyButtons(isVerified) {
  activeGameVerified = isVerified;
  document.getElementById('ga-verify').style.display   = isVerified ? 'none' : '';
  document.getElementById('ga-unverify').style.display = isVerified ? '' : 'none';
}

document.getElementById('ga-verify').addEventListener('click', async () => {
  await gameCmd({ action: 'verify' });
  updateVerifyButtons(true);
});
document.getElementById('ga-unverify').addEventListener('click', async () => {
  await gameCmd({ action: 'unverify' });
  updateVerifyButtons(false);
});
document.getElementById('ga-freeze').addEventListener('click',   () => gameCmd({ action: 'freeze' }));
document.getElementById('ga-unfreeze').addEventListener('click', () => gameCmd({ action: 'unfreeze' }));

async function setServerVerified(region, state) {
  try {
    await post('/api/servers/' + encodeURIComponent(region) + (state ? '/verify' : '/unverify'), {});
    toast(state ? 'Server verified ✓' : 'Server unverified ✓');
  } catch (e) { toast('Error: ' + e.message, true); }
}

function closeAnnouncePanel() { document.getElementById('announce-panel').classList.remove('open'); }
document.getElementById('ga-announce-open').addEventListener('click', () => {
  closeMsgPanel();
  document.getElementById('announce-panel').classList.toggle('open');
});
document.getElementById('ga-announce-cancel').addEventListener('click', closeAnnouncePanel);
async function sendAnnounce() {
  const text  = document.getElementById('announce-input').value.trim();
  const color = document.getElementById('announce-color').value;
  if (!text) return;
  await gameCmd({ action: 'announce', text, color, sender: currentAdminSlug });
  document.getElementById('announce-input').value = '';
  closeAnnouncePanel();
}
document.getElementById('ga-announce-send').addEventListener('click', sendAnnounce);
document.getElementById('announce-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendAnnounce(); });

function openMsg(playerName) {
  msgTargetName = playerName;
  document.getElementById('msg-target-label').textContent = playerName;
  document.getElementById('msg-input').value = '';
  closeAnnouncePanel();
  document.getElementById('msg-panel').classList.add('open');
  document.getElementById('msg-input').focus();
}
function closeMsgPanel() { document.getElementById('msg-panel').classList.remove('open'); }
document.getElementById('msg-cancel-btn').addEventListener('click', closeMsgPanel);
async function sendMsg() {
  const text  = document.getElementById('msg-input').value.trim();
  const color = document.getElementById('msg-color').value;
  if (!text || !msgTargetName) return;
  await gameCmd({ action: 'announce_player', target: msgTargetName, text, color, sender: currentAdminSlug });
  document.getElementById('msg-input').value = '';
  closeMsgPanel();
}
document.getElementById('msg-send-btn').addEventListener('click', sendMsg);
document.getElementById('msg-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(); });

/** Ban a player from the live game view: opens the modal pre-filled, kicks after confirm. */
function quickBanPlayer(name, hash) {
  document.getElementById('modal-ban-type').value   = 'ip';
  document.getElementById('modal-ban-target').value = hash;
  document.getElementById('modal-ban-reason').value = '';
  document.getElementById('modal-ban-days').value   = '7';
  document.getElementById('modal-ban-days').disabled = false;
  document.getElementById('modal-ban-perm').checked = false;
  onBanTypeChange();
  // Store the player name so the confirm handler can also ban the account + kick
  banModal.dataset.kickTarget = name;
  banModal.style.display = 'flex';
}

document.getElementById('gd-close-btn').addEventListener('click', () => {
  document.getElementById('game-detail').style.display = 'none';
  activeGameId = activeGameRegion = '';
  // Revert to server-only SSE (no player stream)
  connectSSE(null, null);
  renderServers();
});

// ═══════════════════════════════════════════════════════════════════════════
// TAB 4 – ACCOUNTS + XP
// ═══════════════════════════════════════════════════════════════════════════

let accountsData = [];
let accountsPassTypes = [];
let accountsSortCol = 'currentXp';
let accountsSortDir = -1; // -1 = desc, 1 = asc

function renderAccountsHeader() {
  const headerRow = document.getElementById('accounts-thead-row');
  // Remove any previously injected pass columns (keep static cols: #, Username, Slug, Discord, Created, Last IP, Flags, GP = 8)
  while (headerRow.children.length > 8) headerRow.removeChild(headerRow.lastChild);
  for (const pt of accountsPassTypes) {
    const shortName = pt.replace('pass_survivr', 'S');
    const th = document.createElement('th');
    th.className = 'sortable';
    th.dataset.col = 'pass_' + pt;
    th.textContent = shortName + ' Lvl';
    headerRow.appendChild(th);
  }
  // Update sort arrows
  document.querySelectorAll('#accounts-table .sortable').forEach(th => {
    const col = th.dataset.col;
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = col === accountsSortCol ? base + (accountsSortDir === 1 ? ' ▲' : ' ▼') : base;
  });
}

async function loadAccounts() {
  const colCount = 8 + accountsPassTypes.length;
  document.getElementById('accounts-tbody').innerHTML = \`<tr><td colspan="\${colCount}" class="loading">Loading…</td></tr>\`;
  try {
    const data = await get('/api/accounts');
    accountsData = data.accounts ?? [];
    accountsPassTypes = data.passTypes ?? [];
    renderAccountsHeader();
    renderAccounts();
  } catch (e) {
    console.error('loadAccounts error:', e);
    document.getElementById('accounts-tbody').innerHTML = \`<tr><td colspan="\${colCount}" class="empty">Failed to load accounts: \${esc(String(e?.message ?? e))} | \${esc(e?.stack?.split('\\n')[1] ?? '')}</td></tr>\`;
  }
}

function renderAccounts() {
  const q = document.getElementById('accounts-search').value.toLowerCase();

  // Optional creation-date range (inclusive). Empty inputs → unbounded on that end.
  // Parsed as local time so a day picked here covers that whole calendar day locally.
  const fromVal = document.getElementById('accounts-date-from').value;
  const toVal   = document.getElementById('accounts-date-to').value;
  let loTs = -Infinity, hiTs = Infinity;
  if (fromVal) { const d = new Date(fromVal + 'T00:00:00');     if (!isNaN(d)) loTs = d.getTime(); }
  if (toVal)   { const d = new Date(toVal + 'T23:59:59.999');   if (!isNaN(d)) hiTs = d.getTime(); }
  const hasDateFilter = loTs !== -Infinity || hiTs !== Infinity;

  let rows = accountsData.filter(a => {
    if (q && !((a.username||'').toLowerCase().includes(q) || (a.slug||'').toLowerCase().includes(q))) return false;
    if (hasDateFilter) {
      const t = a.userCreated ? new Date(a.userCreated).getTime() : NaN;
      if (isNaN(t) || t < loTs || t > hiTs) return false;
    }
    return true;
  });

  // Sort
  rows = [...rows].sort((a, b) => {
    let av, bv;
    if (accountsSortCol.startsWith('pass_')) {
      const pt = accountsSortCol.slice(5);
      av = Number(a.passes?.[pt]?.level ?? -1);
      bv = Number(b.passes?.[pt]?.level ?? -1);
    } else if (accountsSortCol === 'goldenFries') {
      av = Number(a.goldenFries ?? 0);
      bv = Number(b.goldenFries ?? 0);
    } else if (accountsSortCol === 'userCreated') {
      av = a.userCreated ? new Date(a.userCreated).getTime() : -1;
      bv = b.userCreated ? new Date(b.userCreated).getTime() : -1;
    } else {
      av = (a[accountsSortCol] ?? '').toString().toLowerCase();
      bv = (b[accountsSortCol] ?? '').toString().toLowerCase();
    }
    if (av < bv) return -accountsSortDir;
    if (av > bv) return  accountsSortDir;
    return 0;
  });

  // Update header arrows
  document.querySelectorAll('#accounts-table .sortable').forEach(th => {
    const col = th.dataset.col;
    const base = th.textContent.replace(/ [▲▼]$/, '');
    th.textContent = col === accountsSortCol ? base + (accountsSortDir === 1 ? ' ▲' : ' ▼') : base;
  });

  const colCount = 8 + accountsPassTypes.length;
  const tbody = document.getElementById('accounts-tbody');
  tbody.innerHTML = rows.length ? rows.map((a, i) => \`
    <tr style="cursor:pointer" data-nav="\${esc(hAccount(a.slug))}" title="Open account detail">
      <td style="color:var(--text-muted);font-size:11px;">\${i+1}</td>
      <td><span style="color:var(--blue-t)">\${esc(a.username||'–')}</span></td>
      <td style="font-size:11px;color:var(--text-dim);">\${esc(a.slug||'–')}</td>
      <td style="font-size:11px;font-family:monospace;color:var(--text-dim);">\${a.discordId ? esc(a.discordId) : '–'}</td>
      <td style="font-size:11px;color:var(--text-muted);white-space:nowrap;">\${fmtDate(a.userCreated)}</td>
      <td style="font-size:11px;font-family:monospace;">\${a.lastIp ? ipLink(a.lastIp) : '–'}</td>
      <td>
        \${a.admin ? '<span class="badge badge-admin">ADMIN</span>' : ''}
        \${a.banned ? '<span class="badge badge-perm">BANNED</span>' : ''}
      </td>
      <td style="text-align:center;white-space:nowrap;">
        <span style="color:#e0a23c;font-size:11px;">🍟 \${a.goldenFries ?? 0}</span>
        <button class="btn btn-gray btn-sm" style="padding:1px 6px;" onclick="event.stopPropagation();giveGoldenFries('\${esc(a.slug)}', \${a.goldenFries ?? 0})">+GP</button>
      </td>
      \${accountsPassTypes.map(pt => \`<td style="font-weight:600;text-align:center;">\${a.passes?.[pt]?.level ?? '–'}</td>\`).join('')}
    </tr>
  \`).join('') : \`<tr><td colspan="\${colCount}" class="empty">No accounts found.</td></tr>\`;
}


async function giveGoldenFries(slug, current) {
  const input = prompt('Golden Fries für ' + slug + ' (aktuell ' + current + ').\\nBetrag (negativ zum Abziehen):', '100');
  if (input === null) return;
  const amount = parseInt(input, 10);
  if (!Number.isFinite(amount) || amount === 0) { toast('Ungültiger Betrag', true); return; }
  try {
    const data = await post('/api/account/golden-fries', { slug, amount });
    toast(slug + ': ' + (amount > 0 ? '+' : '') + amount + ' 🍟 → ' + data.balance);
    await loadAccounts();
  } catch (e) { toast('Fehler: ' + (e.message || 'Fehlgeschlagen'), true); }
}

// ── Account detail modal ────────────────────────────────────────────────────

const accountModal = document.getElementById('account-modal');
document.getElementById('account-modal-close').addEventListener('click', () => { accountModal.style.display = 'none'; });
accountModal.addEventListener('click', (e) => { if (e.target === accountModal) accountModal.style.display = 'none'; });

// Which account-detail cards are folded. Kept across re-renders (a set-XP / give
// action re-renders the whole modal) so a collapsed card stays collapsed.
const collapsedCards = new Set();
function applyCardCollapse() {
  for (const card of document.querySelectorAll('#account-modal-body .detail-card[data-card]')) {
    card.classList.toggle('collapsed', collapsedCards.has(card.dataset.card));
  }
}
// Clicking a card header folds/unfolds it; ignore clicks on controls in the header
// (e.g. the GP filter select) so those keep working.
document.getElementById('account-modal-body').addEventListener('click', (e) => {
  const h3 = e.target.closest('h3');
  const card = h3 && h3.parentElement;
  if (!card || !card.classList.contains('detail-card') || !card.dataset.card) return;
  if (e.target.closest('select, input, button, a, option, [data-nav]')) return;
  const collapsed = card.classList.toggle('collapsed');
  if (collapsed) collapsedCards.add(card.dataset.card);
  else collapsedCards.delete(card.dataset.card);
});

let currentAccountSlug = '';

async function openAccountDetail(slug) {
  if (slug !== currentAccountSlug) giveQueue = []; // fresh queue when switching accounts
  currentAccountSlug = slug;
  document.getElementById('account-modal-title').textContent = 'Account: ' + slug;
  document.getElementById('account-modal-body').innerHTML = '<div class="loading">Loading…</div>';
  accountModal.style.display = 'flex';
  try {
    renderAccountDetail(await get('/api/account/' + encodeURIComponent(slug)));
  } catch (e) {
    document.getElementById('account-modal-body').innerHTML = '<div class="empty">Account not found.</div>';
  }
}

function buildCosmeticOptions() {
  return Object.entries(COSMETIC_CATALOG).map(([cat, items]) =>
    \`<optgroup label="\${esc(cat)}">\${items.map(t => \`<option value="\${esc(t)}" title="\${esc(t)}">\${esc(cosmeticName(t))}</option>\`).join('')}</optgroup>\`
  ).join('');
}

function renderAccountDetail(data) {
  const u = data.user;
  const linked = u.linkedDiscord ? 'Discord' : u.linkedGoogle ? 'Google' : 'Guest';
  const flags = [
    u.admin  ? '<span class="badge badge-admin">ADMIN</span>'  : '',
    u.banned ? '<span class="badge badge-perm">BANNED</span>'  : '',
  ].join(' ');

  const identity = \`
    <div class="detail-card" data-card="identity">
      <h3>Identity</h3>
      <div class="kv-row"><span class="kv-key">Username:</span><span class="kv-val">\${esc(u.username||'–')}</span></div>
      <div class="kv-row"><span class="kv-key">Slug:</span><span class="kv-val">\${esc(u.slug)}</span></div>
      <div class="kv-row"><span class="kv-key">Discord ID:</span><span class="kv-val">\${u.discordId ? esc(u.discordId) : '–'}</span></div>
      <div class="kv-row"><span class="kv-key">Account:</span><span class="kv-val">\${esc(linked)}</span></div>
      <div class="kv-row"><span class="kv-key">Created:</span><span class="kv-val">\${fmtDate(u.userCreated)}</span></div>
      <div class="kv-row"><span class="kv-key">Golden Fries:</span><span class="kv-val">🍟 \${u.goldenFries ?? 0}</span></div>
      <div style="margin-top:6px;">\${flags}</div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;">
        \${u.admin
          ? '<span style="font-size:11px;color:var(--orange-t);">🛡 Admin account — cannot be deleted.</span>'
          : '<button class="btn btn-red btn-sm" onclick="accDeleteAccount()">🗑 Delete Account</button><span style="font-size:10px;color:var(--text-muted);">permanent — removes items, XP, passes, fries &amp; sessions; match history is anonymized</span>'}
      </div>
    </div>\`;

  const xpByType = {};
  for (const x of (data.xp||[])) xpByType[x.passType] = x;
  const xpRows = (data.passTypes||[]).map(pt => {
    const cur = xpByType[pt] || { level: 0, xp: 0 };
    return \`<tr>
      <td style="font-size:11px;">\${esc(pt)}</td>
      <td><input type="number" id="xp-lvl-\${esc(pt)}" value="\${cur.level}" readonly title="auto-derived from XP" style="width:70px;background:var(--surface3);border:1px solid var(--border);border-radius:4px;color:var(--text-dim);padding:3px 6px;font-family:inherit;"></td>
      <td><input type="number" id="xp-xp-\${esc(pt)}" value="\${cur.xp}" min="0" oninput="updateLvlFromXp('\${esc(pt)}')" style="width:90px;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:3px 6px;font-family:inherit;"></td>
      <td><button class="btn btn-blue btn-sm" onclick="accSetXp('\${esc(pt)}')">Set</button></td>
    </tr>\`;
  }).join('');
  const xpCard = \`
    <div class="detail-card" style="margin-top:12px;" data-card="xp">
      <h3>XP / Pass Levels <span style="color:var(--text-muted);font-weight:400;font-size:11px;">(level is derived from XP; setting it grants/revokes the matching unlocks)</span></h3>
      <table class="data-table"><thead><tr><th>Pass</th><th>Level</th><th>Total XP</th><th></th></tr></thead>
      <tbody>\${xpRows || '<tr><td colspan="4" class="empty">No passes.</td></tr>'}</tbody></table>
    </div>\`;

  const gpCard = \`
    <div class="detail-card" style="margin-top:12px;" data-card="gp">
      <h3 style="display:flex;align-items:center;gap:8px;">GP History
        <span style="color:var(--text-muted);font-weight:400;font-size:11px;">(Golden Fries earned / spent)</span>
        <select id="gp-filter" onchange="loadAccountGp(currentAccountSlug, this.value)" style="margin-left:auto;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:3px 8px;font-family:inherit;font-size:11px;">
          <option value="all">All</option>
          <option value="earned">Earned</option>
          <option value="spent">Spent</option>
        </select>
      </h3>
      <div id="gp-history"><div class="loading">Loading…</div></div>
    </div>\`;

  const giveCard = \`
    <div class="detail-card" style="margin-top:12px;" data-card="give">
      <h3>Give Item</h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <select id="give-item-select" style="background:var(--surface2);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:5px 8px;font-family:inherit;max-width:320px;">\${buildCosmeticOptions()}</select>
        <button class="btn btn-blue btn-sm" onclick="giveQueueAdd()">+ Add</button>
        <input id="give-source" type="text" value="admin_grant" title="source" style="width:130px;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;color:var(--text);padding:5px 8px;font-family:inherit;">
        <button class="btn btn-green btn-sm" onclick="accGiveItem()">Give selected</button>
        <button class="btn btn-gray btn-sm" onclick="accGiveItem('all')">Give ALL</button>
      </div>
      <div id="give-queue" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;"></div>
    </div>\`;

  const groups = Object.entries(data.itemsBySource || {});
  const removeInner = groups.length ? groups.map(([src, items]) => \`
    <div style="margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="font-size:11px;color:var(--text-dim);font-weight:600;">\${esc(src)} <span style="color:var(--text-muted)">(\${items.length})</span></span>
        <button class="btn btn-red btn-sm" onclick="accRemoveSource('\${esc(src)}')">Remove all</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;">
        \${items.map(it => \`<span class="badge badge-disc" style="display:inline-flex;align-items:center;gap:5px;" title="\${esc(it.type)}">\${esc(cosmeticName(it.type))} <span style="cursor:pointer;color:var(--red-t);font-weight:700;" onclick="accRemoveItem('\${esc(it.type)}')">✕</span></span>\`).join('')}
      </div>
    </div>\`).join('') : '<div class="empty">No items owned.</div>';
  const removeCard = \`<div class="detail-card" style="margin-top:12px;" data-card="items"><h3>Owned Items</h3>\${removeInner}</div>\`;

  const matchRows = (data.matches || []).map(m => \`<tr>
    <td style="font-size:11px;white-space:nowrap;">\${fmtDate(m.createdAt)}</td>
    <td>\${esc(m.mapId||'?')}</td>
    <td>\${esc(m.teamMode||'?')}</td>
    <td>#\${m.rank}</td>
    <td>\${m.kills}</td>
    <td>\${m.damageDealt}</td>
    <td>\${m.timeAlive}s</td>
  </tr>\`).join('');
  const matchCard = \`
    <div class="detail-card" style="margin-top:12px;" data-card="matches">
      <h3>Recent Matches</h3>
      <table class="data-table"><thead><tr><th>Date</th><th>Map</th><th>Mode</th><th>Rank</th><th>Kills</th><th>Dmg</th><th>Alive</th></tr></thead>
      <tbody>\${matchRows || '<tr><td colspan="7" class="empty">No matches.</td></tr>'}</tbody></table>
    </div>\`;

  document.getElementById('account-modal-body').innerHTML = identity + xpCard + gpCard + giveCard + removeCard + matchCard;
  applyCardCollapse();
  renderGiveQueue();
  loadAccountGp(u.slug, 'all');
}

// ── Give-Item queue (pick skins one at a time, ✕ to drop, then grant all) ─────
// Kept while the same account modal stays open; cleared when switching accounts
// or after a successful "Give selected".
let giveQueue = [];

function renderGiveQueue() {
  const cont = document.getElementById('give-queue');
  if (!cont) return;
  cont.innerHTML = giveQueue.length
    ? giveQueue.map(t => \`<span class="badge badge-disc" style="display:inline-flex;align-items:center;gap:5px;" title="\${esc(t)}">\${esc(cosmeticName(t))} <span style="cursor:pointer;color:var(--red-t);font-weight:700;" onclick="giveQueueRemove('\${esc(t)}')">✕</span></span>\`).join('')
    : '<span style="font-size:11px;color:var(--text-muted);">No items queued — pick one and press "+ Add".</span>';
}

function giveQueueAdd() {
  const t = document.getElementById('give-item-select').value;
  if (!t) return;
  if (!giveQueue.includes(t)) giveQueue.push(t);
  renderGiveQueue();
}

function giveQueueRemove(t) {
  giveQueue = giveQueue.filter(x => x !== t);
  renderGiveQueue();
}

async function loadAccountGp(slug, filter) {
  const cont = document.getElementById('gp-history');
  if (!cont) return;
  cont.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await get('/api/account/' + encodeURIComponent(slug) + '/gp?filter=' + encodeURIComponent(filter || 'all'));
    renderAccountGp(data);
  } catch (e) {
    cont.innerHTML = '<div class="empty">Failed to load GP history.</div>';
  }
}

// Human-readable ledger reason. Market trades show the item + a clickable counterparty
// so it's clear who the fries went to (buy) or came from (sell).
function gpReason(e) {
  const m = e.market;
  if (m) {
    const item = esc(cosmeticName(m.item) || m.item);
    const who = m.counterpartySlug
      ? navLink(hAccount(m.counterpartySlug), esc(m.counterpartyName || m.counterpartySlug), { title: 'Open account' })
      : esc(m.counterpartyName || 'unknown');
    return m.direction === 'buy'
      ? 'Bought ' + item + ' <span style="color:var(--text-muted)">from</span> ' + who
      : 'Sold ' + item + ' <span style="color:var(--text-muted)">to</span> ' + who;
  }
  // Market row whose listing no longer exists: it is cascade-deleted when the traded
  // item or the counterparty's account is deleted, so the partner can't be recovered.
  const gone = /^market:(buy|sell):(\d+)$/.exec(e.reason || '');
  if (gone) {
    const verb = gone[1] === 'buy' ? 'Bought' : 'Sold';
    return verb + ' item <span style="color:var(--text-muted)">· listing #' + esc(gone[2]) + ' (counterparty account deleted)</span>';
  }
  return esc(e.reason);
}

function renderAccountGp(data) {
  const cont = document.getElementById('gp-history');
  if (!cont) return;
  const entries = data.entries ?? [];
  const summary = \`<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;margin-bottom:8px;">
      <span>Balance: <strong>🍟 \${data.balance ?? 0}</strong></span>
      <span style="color:var(--green-t)">Earned +\${(data.totalEarned ?? 0).toLocaleString()}</span>
      <span style="color:var(--red-t)">Spent -\${(data.totalSpent ?? 0).toLocaleString()}</span>
      <span style="color:var(--text-dim)">\${data.count ?? entries.length} total entries</span>
    </div>\`;
  const rows = entries.map(e => {
    const earn = e.amount >= 0;
    return \`<tr>
      <td style="font-size:11px;white-space:nowrap;">\${fmtDate(e.createdAt)}</td>
      <td style="font-weight:600;white-space:nowrap;color:\${earn ? 'var(--green-t)' : 'var(--red-t)'};">\${earn ? '+' : ''}\${e.amount.toLocaleString()}</td>
      <td style="font-size:11px;">\${gpReason(e)}</td>
      <td style="font-size:11px;color:var(--text-dim);">🍟 \${e.balanceAfter}</td>
    </tr>\`;
  }).join('');
  cont.innerHTML = summary + (entries.length
    ? \`<table class="data-table"><thead><tr><th>Date</th><th>Amount</th><th>Reason</th><th>Balance</th></tr></thead><tbody>\${rows}</tbody></table>\`
    : '<div class="empty">No GP history for this filter.</div>');
}

async function accSetXp(passType) {
  // Level is derived from XP server-side, so we only send the (total) XP.
  const xp = parseFloat(document.getElementById('xp-xp-' + passType).value) || 0;
  try {
    const r = await post('/api/account/set-xp', { slug: currentAccountSlug, passType, xp });
    toast(passType + ' → lvl ' + (r.level ?? '?') + ' (+' + (r.granted ?? 0) + ' / -' + (r.revoked ?? 0) + ' items)');
    openAccountDetail(currentAccountSlug);
  } catch (e) { toast('Error: ' + e.message, true); }
}

async function accGiveItem(item) {
  // 'all' (or an explicit single type) is a shortcut; otherwise give every queued skin.
  const items = item ? [item] : giveQueue.slice();
  if (!items.length) { toast('No item queued — pick one and press "+ Add".', true); return; }
  const source = (document.getElementById('give-source').value || '').trim() || 'admin_grant';
  try {
    let total = 0;
    for (const it of items) {
      const r = await post('/api/account/give-item', { slug: currentAccountSlug, item: it, source });
      total += (r.given ?? 0);
    }
    toast('Gave ' + total + ' item(s)');
    if (!item) giveQueue = []; // clear the queue after a successful "Give selected"
    openAccountDetail(currentAccountSlug);
  } catch (e) { toast('Error: ' + e.message, true); }
}

async function accRemoveItem(item) {
  try {
    const r = await post('/api/account/remove-item', { slug: currentAccountSlug, item });
    toast('Removed ' + (r.removed ?? 0) + ' (' + item + ')');
    openAccountDetail(currentAccountSlug);
  } catch (e) { toast('Error: ' + e.message, true); }
}

async function accRemoveSource(source) {
  if (!confirm('Remove ALL items with source "' + source + '"?')) return;
  try {
    const r = await post('/api/account/remove-item-source', { slug: currentAccountSlug, source });
    toast('Removed ' + (r.removed ?? 0) + ' items (' + source + ')');
    openAccountDetail(currentAccountSlug);
  } catch (e) { toast('Error: ' + e.message, true); }
}

async function accDeleteAccount() {
  const slug = currentAccountSlug;
  const typed = prompt('⚠️ Permanently DELETE account "' + slug + '"?\\n' +
    'This removes the user, their items, XP, passes, golden fries and sessions ' +
    '(match history is anonymized). This cannot be undone.\\n\\nType the slug to confirm:');
  if (typed === null) return;
  if (typed !== slug) { toast('Slug mismatch — deletion aborted', true); return; }
  try {
    await post('/api/account/delete', { slug });
    toast('Account "' + slug + '" deleted');
    accountModal.style.display = 'none';
    loadAccounts();
  } catch (e) { toast('Error: ' + (e.message || 'failed'), true); }
}

document.getElementById('accounts-search').addEventListener('input', renderAccounts);
document.getElementById('accounts-date-from').addEventListener('change', renderAccounts);
document.getElementById('accounts-date-to').addEventListener('change', renderAccounts);
document.getElementById('accounts-date-clear').addEventListener('click', () => {
  document.getElementById('accounts-date-from').value = '';
  document.getElementById('accounts-date-to').value = '';
  renderAccounts();
});

document.getElementById('accounts-table').addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const col = th.dataset.col;
  if (accountsSortCol === col) {
    accountsSortDir *= -1;
  } else {
    accountsSortCol = col;
    accountsSortDir = (col.startsWith('pass_') || col === 'userCreated' || col === 'goldenFries') ? -1 : 1;
  }
  renderAccounts();
  renderAccountsHeader();
});

document.getElementById('reconcile-btn').addEventListener('click', async () => {
  const btn = document.getElementById('reconcile-btn');
  const result = document.getElementById('reconcile-result');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  result.textContent = '';
  try {
    const data = await post('/api/reconcile_pass_xp', {});
    result.textContent = \`Done: \${data.usersReconciled} users fixed, +\${data.totalXpAdded} XP, \${data.totalUnlocksGranted} unlocks granted, \${data.totalGoldenFriesAwarded} 🍟 fries\`;
    result.style.color = 'var(--green-t)';
    await loadAccounts();
  } catch (e) {
    result.textContent = 'Error: ' + e.message;
    result.style.color = 'var(--red-t)';
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Reconcile All Passes + Unlocks';
  }
});

// ── Admin chat send ────────────────────────────────────────────────────────

document.getElementById('chat-send-btn').addEventListener('click', async () => {
  const input = document.getElementById('chat-send-input');
  const text = input.value.trim();
  if (!text || !activeGameId) return;
  input.value = '';
  await gameCmd({ action: 'chat', text, sender: currentAdminSlug || 'ADMIN' });
});

document.getElementById('chat-send-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('chat-send-btn').click();
});

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

(async () => {
  try {
    const me = await get('/api/me');
    currentAdminId   = me.id;
    currentAdminSlug = me.slug;
    document.getElementById('topbar-user').textContent = 'Logged in as ' + (me.username || me.slug);
  } catch { /* already redirected by server */ }

  // Open initial SSE stream (covers both bans tab and basic server info)
  connectSSE(null, null);

  // Deep-link routing: when opened via a nav link in a new tab (Ctrl/middle-click),
  // land straight in the target view. Also react to manual hash changes.
  routeFromHash(location.hash);
  window.addEventListener('hashchange', () => routeFromHash(location.hash));
})();
</script>
</body>
</html>`;
