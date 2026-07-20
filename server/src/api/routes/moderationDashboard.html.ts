import { GameObjectDefs } from "../../../../shared/defs/register.ts";
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
        COSMETIC_NAMES[t] = (GameObjectDefs.typeToDefSafe(t) as { name?: string })?.name || t;
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
    /* XP-Gain exclusion filter panel */
    .xp-exclude-title { font-size: 10px; font-weight: 700; letter-spacing: .5px; color: var(--text-dim); margin-bottom: 6px; }
    .xp-exclude-group { display: flex; gap: 12px; flex-wrap: wrap; }
    .xp-exclude-group label { display: flex; align-items: center; gap: 5px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .xp-exclude-group .empty-note { font-size: 11px; color: var(--text-muted); }
    /* XP-Gain sub-tabs — own class so they don't trip the global .sub-tab-btn handler. */
    .xp-sub-btn { padding: 5px 14px; border-radius: 20px; border: 1px solid var(--border2); background: none; color: var(--text-dim); cursor: pointer; font-size: 12px; font-family: inherit; }
    .xp-sub-btn.active { background: var(--blue-dim); border-color: var(--blue); color: var(--blue-t); }

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
    .badge-mod    { background: var(--blue-dim);   color: var(--blue-t);   border: 1px solid var(--blue); }
    .badge-self   { background: var(--green-dim);  color: var(--green-t);  border: 1px solid var(--green); }
    .badge-alive  { background: var(--green-dim);  color: var(--green-t);  }
    .badge-dead   { background: var(--red-dim);    color: var(--red-t);    }
    .badge-spec   { background: var(--surface3);   color: var(--text-dim); }
    .badge-perm   { background: var(--red-dim);    color: var(--red-t);    border: 1px solid var(--red); }
    .badge-temp   { background: var(--orange-dim); color: var(--orange-t); }
    .badge-disc   { background: var(--surface3);   color: var(--text-muted); border: 1px solid var(--border2); }
    .badge-sus     { background: var(--orange-dim); color: var(--orange-t); border: 1px solid var(--orange); }
    .badge-botted  { background: var(--red-dim);    color: var(--red-t);    border: 1px solid var(--red); }
    .badge-removed { background: var(--surface3);   color: var(--orange-t); border: 1px solid var(--orange); }

    /* XP-Gain "Games" sub-tab — expandable per-game roster rows. */
    .xp-game-row:hover td { background: var(--surface2); }
    .xp-detail-row > td { background: var(--surface); padding: 0; border-bottom: 1px solid var(--border2); }
    .xp-detail-wrap { padding: 10px 14px; }
    .xp-modacts { display: inline-flex; gap: 4px; margin-left: 6px; }

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
  <button class="tab-btn"        data-tab="games">Games</button>
  <button class="tab-btn"        data-tab="sus">Sus</button>
  <button class="tab-btn"        data-tab="leaderboard">Leaderboard</button>
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
          <th>Slug</th><th>Username</th><th>Reason</th><th>Banned By</th><th>Type</th><th>Expires</th><th>Actions</th>
        </tr></thead>
        <tbody id="account-ban-tbody"><tr><td colspan="7" class="loading">Loading…</td></tr></tbody>
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
      <div class="sub-tabs">
        <button class="xp-sub-btn active" data-xpsub="players">Players</button>
        <button class="xp-sub-btn"        data-xpsub="games">Games</button>
      </div>
      <span style="font-size:12px;color:var(--text-dim);">XP gained in</span>
      <select id="xp-window" title="Time window"
        style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="24h">Last 24 hours</option>
        <option value="7d" selected>Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </select>
      <select id="xp-games-region" title="Filter by server region" style="display:none;background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="">All regions</option>
      </select>
      <button class="btn btn-gray" id="xp-exclude-btn" title="Exclude tags and servers from this view">⊘ Exclude<span id="xp-exclude-count"></span></button>
      <button class="btn btn-gray" id="xp-refresh-btn">↻ Refresh</button>
      <span id="xp-hint" style="font-size:11px;color:var(--text-dim);">Top XP gainers — sudden spikes may indicate account boosting.</span>
    </div>

    <!-- Exclusion filters — applied server-side to BOTH sub-tabs -->
    <div id="xp-exclude-panel" style="display:none;background:var(--surface3);border:1px solid var(--border2);border-radius:6px;padding:10px 12px;margin-bottom:10px;">
      <div style="display:flex;gap:28px;flex-wrap:wrap;">
        <div>
          <div class="xp-exclude-title">EXCLUDE TAGS</div>
          <div id="xp-exclude-tags" class="xp-exclude-group"></div>
        </div>
        <div>
          <div class="xp-exclude-title">EXCLUDE SERVERS</div>
          <div id="xp-exclude-regions" class="xp-exclude-group"></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:9px;">
        <button class="btn btn-gray btn-sm" id="xp-exclude-clear">Clear all</button>
        <span style="font-size:11px;color:var(--text-dim);">Excluded rows are dropped before ranking, so totals and the top-N reflect the filter.</span>
      </div>
    </div>

    <div id="xp-sub-players">
      <div id="xp-container"><div class="loading">Loading…</div></div>
    </div>
    <div id="xp-sub-games" style="display:none">
      <div id="xp-games-container"><div class="loading">Loading…</div></div>
    </div>
  </div>

  <!-- ════════════════ TAB: LEADERBOARD ════════════════ -->
  <div id="tab-leaderboard" class="tab-pane">
    <div class="toolbar">
      <select id="lb-type" title="Stat" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="kills">Kills</option>
        <option value="wins">Wins</option>
        <option value="kpg">K / Game</option>
        <option value="most_damage_dealt">Max Damage</option>
      </select>
      <select id="lb-mode" title="Team mode" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="1">Solo</option>
        <option value="2">Duo</option>
        <option value="4">Squad</option>
      </select>
      <select id="lb-interval" title="Time interval" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="alltime">All time</option>
        <option value="weekly">Last 7 days</option>
        <option value="daily">Last 24 hours</option>
      </select>
      <select id="lb-map" title="Map" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="">All maps</option>
      </select>
      <button class="btn btn-gray" id="lb-refresh-btn">↻ Refresh</button>
      <span style="font-size:11px;color:var(--text-dim);">Click a player to open their games, expand a game to see all players and delete botted ones.</span>
    </div>
    <div id="lb-container"><div class="loading">Loading…</div></div>
  </div>

  <!-- ════════════════ TAB: GAMES ════════════════ -->
  <div id="tab-games" class="tab-pane">
    <div class="toolbar" style="flex-wrap:wrap;">
      <input id="games-search" type="text" placeholder="Game ID (exact), in-game name or slug…" title="Paste a game ID for its roster, or type an in-game name (matches part of it, guests included) or an exact account slug" style="width:280px;background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
      <select id="games-map" title="Map" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;"><option value="">All maps</option></select>
      <select id="games-mode" title="Team mode" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="">All modes</option><option value="1">Solo</option><option value="2">Duo</option><option value="4">Squad</option>
      </select>
      <select id="games-window" title="Time window" style="background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
        <option value="24h">Last 24h</option><option value="7d" selected>Last 7 days</option><option value="30d">Last 30 days</option><option value="3650d">All time</option>
      </select>
      <input id="games-minkills" type="number" min="0" placeholder="min K" title="Min top kills" style="width:70px;background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
      <input id="games-mindmg" type="number" min="0" placeholder="min Dmg" title="Min top damage" style="width:80px;background:var(--surface2);border:1px solid var(--border2);border-radius:6px;color:var(--text);padding:6px 8px;font-family:inherit;font-size:12px;">
      <button class="btn btn-blue" id="games-search-btn">🔍 Search</button>
      <span style="font-size:11px;color:var(--text-dim);">Paste a game ID to jump straight to its roster; otherwise filter recent games by in-game name (guests included) or account slug. Expand a game for the full roster + botted/remove/delete.</span>
    </div>
    <div id="games-container"><div class="empty">Enter a game ID or set filters, then hit Search.</div></div>
  </div>

  <!-- ════════════════ TAB: SUS (admin-only review queue) ════════════════ -->
  <div id="tab-sus" class="tab-pane">
    <div class="toolbar">
      <input type="text" id="sus-search" placeholder="Search by player, reason, moderator or game id…" style="max-width:420px">
      <button class="btn btn-gray" id="sus-refresh-btn">↻ Refresh</button>
      <span style="font-size:11px;color:var(--text-dim);">Everything staff flagged as suspicious, newest first — with the reason and who raised it.</span>
    </div>
    <div id="sus-container"><div class="loading">Loading…</div></div>
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
      <!-- Duration fields – used by IP, chat and account bans -->
      <div id="modal-duration-block">
        <div style="color:var(--text-dim);margin-bottom:4px;">Duration</div>
        <label style="display:flex;align-items:center;gap:6px;color:var(--text-dim);cursor:pointer;margin-bottom:6px;">
          <input id="modal-ban-perm" type="checkbox" onchange="syncBanDurationInputs()">
          Permanent
        </label>
        <div id="modal-ban-timed" style="display:flex;flex-direction:column;gap:6px;">
          <label style="display:flex;align-items:center;gap:8px;color:var(--text-dim);cursor:pointer;">
            <input type="radio" name="modal-ban-mode" value="duration" checked onchange="syncBanDurationInputs()">
            <span style="min-width:38px;">For</span>
            <input id="modal-ban-days" type="number" value="7" min="0" step="any" style="width:70px;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;">
            <select id="modal-ban-unit" style="background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;">
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days" selected>Days</option>
            </select>
          </label>
          <label style="display:flex;align-items:center;gap:8px;color:var(--text-dim);cursor:pointer;">
            <input type="radio" name="modal-ban-mode" value="until" onchange="syncBanDurationInputs()">
            <span style="min-width:38px;">Until</span>
            <input id="modal-ban-until" type="datetime-local" style="background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;">
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

<!-- ── Generic dialog: replaces window.confirm / window.prompt everywhere ── -->
<div id="ui-modal" style="display:none;position:fixed;inset:0;background:#00000088;z-index:130;align-items:center;justify-content:center;">
  <div style="background:var(--surface);border:1px solid var(--border2);border-radius:10px;padding:20px;width:430px;max-width:100%;display:flex;flex-direction:column;gap:12px;">
    <div id="ui-modal-title" style="font-weight:700;font-size:14px;"></div>
    <div id="ui-modal-body" style="font-size:12px;color:var(--text-dim);line-height:1.55;"></div>
    <div id="ui-modal-field" style="font-size:12px;display:none;">
      <div id="ui-modal-label" style="color:var(--text-dim);margin-bottom:4px;"></div>
      <textarea id="ui-modal-textarea" rows="3"
        style="display:none;width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;resize:vertical;outline:none;box-sizing:border-box;"></textarea>
      <input id="ui-modal-input" type="text"
        style="display:none;width:100%;background:var(--surface2);border:1px solid var(--border2);border-radius:4px;padding:6px;color:var(--text);font-family:inherit;font-size:12px;outline:none;box-sizing:border-box;">
      <div style="display:flex;align-items:center;gap:8px;margin-top:5px;">
        <span id="ui-modal-hint" style="font-size:11px;color:var(--text-muted);"></span>
        <span id="ui-modal-count" style="margin-left:auto;font-size:11px;color:var(--text-muted);"></span>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
      <span id="ui-modal-keys" style="font-size:10px;color:var(--text-muted);"></span>
      <button class="btn btn-gray" id="ui-modal-cancel" style="margin-left:auto;">Cancel</button>
      <button class="btn btn-red"  id="ui-modal-confirm">OK</button>
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
// Staff role of the logged-in user. Moderators reach only the Replays + XP Gain tabs
// and may only mark things "sus" — every XP-moving control is hidden for them. This is
// UX only: the server independently 403s the routes and statuses they may not use.
let isAdmin     = false;
let isModerator = false;
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
function hGame(gid)           { return 'view=game&gameId=' + encodeURIComponent(gid); }
function hXpUser(userId, win) { return 'view=xpuser&userId=' + encodeURIComponent(userId) + (win ? '&window=' + encodeURIComponent(win) : ''); }

// Inline cross-link (styled span). labelHtml is already-escaped HTML.
function navLink(hash, labelHtml, opts) {
  opts = opts || {};
  const cls   = 'nav-link' + (opts.cls ? ' ' + opts.cls : '');
  const style = opts.style ? ' style="' + opts.style + '"' : '';
  const title = opts.title ? ' title="' + esc(opts.title) + '"' : '';
  return '<span class="' + cls + '" data-nav="' + esc(hash) + '"' + style + title + '>' + labelHtml + '</span>';
}

// Same deep-link behaviour as navLink (incl. Ctrl/middle-click → new tab), but rendered
// as a real button — for action columns, where a bare text link next to buttons reads
// like it does something different. The delegated handler below already treats a button
// that carries its OWN data-nav as the nav element, so this needs no extra wiring.
function navButton(hash, labelHtml, opts) {
  opts = opts || {};
  const title = opts.title ? ' title="' + esc(opts.title) + '"' : '';
  return '<button class="btn ' + (opts.cls || 'btn-gray') + ' btn-sm" data-nav="' + esc(hash) + '"' + title + '>' + labelHtml + '</button>';
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
  } else if (view === 'game') {
    // An exact game id makes loadGamesSearch jump straight to that game's roster.
    const gid = p.get('gameId');
    switchTab('games');
    if (gid) {
      const el = document.getElementById('games-search');
      if (el) el.value = gid;
      loadGamesSearch();
    }
  } else if (view === 'sus') {
    switchTab('sus');
  } else if (view === 'xpuser') {
    const win = p.get('window');
    if (win) { const sel = document.getElementById('xp-window'); if (sel) sel.value = win; }
    switchTab('xp');
    const userId = p.get('userId');
    if (userId) loadXpUser(userId);
  }
}

// Cross-links into admin-only tabs (lookup, accounts, chat log, games). A moderator can
// reach neither the tab nor its API, so the link degrades to plain text for them rather
// than dead-ending on a hidden tab.
function adminNavLink(hash, labelHtml, opts) {
  return isAdmin
    ? navLink(hash, labelHtml, opts)
    : '<span style="color:var(--text-dim)">' + labelHtml + '</span>';
}

function ipLink(hash) {
  const label = esc(hash.slice(0, 12)) + '…';
  return isAdmin
    ? navLink(hLookup(hash), label, { cls: 'ip-link', title: hash })
    : '<span class="ip-link" style="text-decoration:none;cursor:default;color:var(--text-dim)" title="' + esc(hash) + '">' + label + '</span>';
}

/**
 * The "player" cell shared by the game roster and the Sus tab.
 *
 * Clicking the name lands on the IP they used in THAT game (IP / Player tab) — the usual
 * next step when reviewing a game, and the only handle on a guest, who has no account.
 * The account stays one click away via the slug. Ctrl/middle-click opens either in a new
 * tab, like every other nav link.
 *
 * Takes anything with { username, slug, encodedIp } — the roster and Sus rows both match.
 */
function playerIpCell(p, fallbackLabel) {
  const label = esc(p.username || p.slug || fallbackLabel || '(guest)');
  const name = p.encodedIp
    ? adminNavLink(hLookup(p.encodedIp), label, { title: 'Look up the IP this player used in this game' })
    : p.slug
      ? adminNavLink(hAccount(p.slug), label, { title: 'Open account' })
      : '<span style="color:var(--text-muted)">' + label + '</span>';
  const slug = p.slug
    ? ' ' + adminNavLink(hAccount(p.slug), '(' + esc(p.slug) + ')', { title: 'Open account', style: 'font-size:10px;color:var(--text-muted)' })
    : '';
  return name + slug;
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
    refreshXp();
  } else if (name === 'games') {
    closeSSE();
  } else if (name === 'sus') {
    closeSSE();
    loadSus();
  } else if (name === 'leaderboard') {
    closeSSE();
    loadLeaderboard();
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
      // Slugs are shown in the table, so they're searchable too.
      const hay = (rec.gameId + ' ' + rec.mapName + ' ' +
        (rec.players ?? []).map(p => p.playerName + ' ' + (p.slug || '')).join(' ')).toLowerCase();
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
    const rows = (rec.players ?? []).map(p => {
      // Three states, kept apart: an account, a guest (played without one), and a POV
      // whose game wrote no match_data at all — where we simply don't know.
      const slugCell = p.slug
        ? adminNavLink(hAccount(p.slug), esc(p.slug), { title: 'Open account' })
        : p.noData
          ? '<span style="color:var(--text-muted)" title="This game has no match data — nothing to flag">–</span>'
          : '<span class="badge badge-spec" title="Played without an account">GUEST</span>';
      const banned = p.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
      return \`
      <tr>
        <td>\${esc(p.playerName)}\${banned}</td>
        <td>\${slugCell}</td>
        <td>\${p.kills ?? '—'}</td>
        <td>\${p.damageDealt ?? '—'}</td>
        <td>\${p.damageTaken ?? '—'}</td>
        <td>\${fmtAlive(p.timeAlive)}</td>
        <td style="color:var(--text-dim)">\${(p.bytes / 1024 / 1024).toFixed(1)} MB</td>
        <td><span class="rep-modcell" data-key="\${esc(rec.gameId + '|' + (p.modKey || ''))}">\${modBadge(p.modStatus)}</span></td>
        <td style="white-space:nowrap">
          <span style="display:inline-flex;gap:5px;align-items:center;">
            <button class="btn btn-blue btn-sm" onclick="watchReplay('\${esc(regionId)}','\${esc(rec.gameId)}',\${p.playerId})">▶ Watch</button>
            \${p.modKey
              ? \`<button class="btn btn-orange btn-sm" data-repsus="\${esc(rec.gameId)}" data-repname="\${esc(p.playerName)}" title="Flag this \${p.guest ? 'guest' : 'player'} in this game as suspicious">⚑ sus</button>\`
              : ''}
          </span>
        </td>
      </tr>\`;
    }).join('');
    // The game id jumps to the Games tab (admins only — moderators have no Games tab,
    // so it stays plain text for them rather than linking somewhere they can't go).
    const gidCell = isAdmin
      ? navLink(hGame(rec.gameId), '<span class="gid">' + esc(rec.gameId) + '</span>', { title: 'Open this game in the Games tab' })
      : '<span class="gid">' + esc(rec.gameId) + '</span>';
    return \`
      <div class="chat-game-group">
        <div class="chat-game-header">
          \${gidCell}
          <span>\${esc(regionId)}</span>
          <span>\${esc(rec.mapName)} · \${mode}</span>
          <span>\${durStr}</span>
          <span class="rep-modcell" data-key="\${esc(rec.gameId + '|')}">\${modBadge(rec.gameStatus)}</span>
          <button class="btn btn-orange btn-sm" data-repsus="\${esc(rec.gameId)}" title="Flag this whole game as suspicious">⚑ sus game</button>
          <span style="margin-left:auto">\${fmtDate(rec.startTs)}</span>
        </div>
        <table class="data-table" style="margin:0">
          <thead><tr><th>Player POV</th><th>Slug</th><th>Kills</th><th>Dmg dealt</th><th>Dmg taken</th><th>Alive</th><th>Size</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>\${rows || '<tr><td colspan="9" class="empty">No POVs.</td></tr>'}</tbody>
        </table>
      </div>\`;
  }).join('');
}

// Flags a replayed game (or one POV within it) as suspicious. Without a player name the
// flag covers the whole game. Delegated, so it also covers re-rendered rows.
document.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-repsus]');
  if (!btn) return;
  markReplaySus(btn.dataset.repsus, btn.dataset.repname || null);
});

async function markReplaySus(gameId, playerName) {
  const reason = await askSusReason(susTargetLabel(playerName, gameId));
  if (reason === null) return;
  try {
    const body = { gameId: gameId, reason: reason };
    if (playerName) body.playerName = playerName;
    // The server resolves the name to an account or a guest slot and tells us which.
    const res = await post('/api/replays/sus', body);
    // Patch the badge in place so the flag is visible without a reload.
    const key = gameId + '|' + (res.modKey || '');
    document.querySelectorAll('.rep-modcell').forEach(function (el) {
      if (el.dataset.key === key) el.innerHTML = modBadge('sus');
    });
    toast(!playerName ? 'Flagged game as suspicious'
      : res.guest ? 'Flagged guest ' + playerName + ' as suspicious'
      : 'Flagged ' + playerName + ' as suspicious');
  } catch (e) {
    toast(/player_not_in_game/.test(e.message)
      ? 'That POV has no match data — flag the whole game instead'
      : 'Failed to flag: ' + e.message, true);
  }
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
    const data = await get('/api/xp-gain?window=' + encodeURIComponent(win) + xpExcludeQuery());
    if (token !== xpLoadToken) return;
    setXpRegions(data.regions || []);
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
      ? \`\${adminNavLink(hLookup(u.slug), label, { title: 'Look up account' })} <span style="color:var(--text-muted);font-size:10px;">(\${esc(u.slug)})</span>\`
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
  const lookup = data.slug ? ' · ' + adminNavLink(hLookup(data.slug), 'look up account', { title: 'Open IP / Player lookup' }) : '';
  const rows = games.slice().reverse().map(g => {
    const mode = TEAM_MODE_LABEL[g.teamMode] || ('Mode ' + g.teamMode);
    return \`<tr id="xpgame-\${esc(g.gameId)}"\${g.removed ? ' style="opacity:.55"' : ''}>
      <td style="white-space:nowrap;font-size:11px;">\${fmtDate(g.createdAt)}</td>
      <td>\${esc(g.region || '–')}</td>
      <td>\${esc(g.mapName)} · \${mode}\${g.removed ? ' ' + modBadge('removed') : ''}</td>
      <td>\${g.kills}</td>
      <td>\${g.damage}</td>
      <td>\${g.rank}</td>
      <td>\${fmtSecs(g.timeAlive)}</td>
      <td><strong>\${g.xp.toLocaleString()}</strong></td>
      <td style="white-space:nowrap;">\${navLink(hReplays(g.gameId), 'replay', { title: 'Find the replay of this game' })} · \${adminNavLink(hChatGame(g.gameId, null), 'chat', { title: 'Open this game\\'s chat' })}</td>
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

document.getElementById('xp-refresh-btn').addEventListener('click', refreshXp);
document.getElementById('xp-window').addEventListener('change', refreshXp);
document.getElementById('xp-games-region').addEventListener('change', loadXpGames);

// ═══════════════════════════════════════════════════════════════════════════
// TAB – XP GAIN › GAMES sub-tab (per-(player,game) list, expandable roster, bott)
// ═══════════════════════════════════════════════════════════════════════════

// Active XP sub-tab: 'players' = leaderboard (unchanged), 'games' = per-game list.
let xpActiveSub = 'players';

function switchXpSub(name) {
  xpActiveSub = name;
  document.querySelectorAll('#tab-xp .xp-sub-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.xpsub === name); });
  document.getElementById('xp-sub-players').style.display = name === 'players' ? '' : 'none';
  document.getElementById('xp-sub-games').style.display   = name === 'games'   ? '' : 'none';
  const region = document.getElementById('xp-games-region');
  if (region) region.style.display = name === 'games' ? '' : 'none';
  const hint = document.getElementById('xp-hint');
  if (hint) hint.textContent = name === 'games'
    ? (isAdmin
        ? 'Each row is one player in one game. Expand a row to see all players and mark them sus or botted.'
        : 'Each row is one player in one game. Expand a row to see all players and mark them sus.')
    : 'Top XP gainers — sudden spikes may indicate account boosting.';
  refreshXp();
}
document.querySelectorAll('#tab-xp .xp-sub-btn').forEach(function (b) {
  b.addEventListener('click', function () { switchXpSub(b.dataset.xpsub); });
});

// Refresh whichever XP sub-tab is currently showing (shared window + refresh button).
function refreshXp() { if (xpActiveSub === 'games') loadXpGames(); else loadXpGain(); }

async function loadXpGames() {
  const container = document.getElementById('xp-games-container');
  const token = ++xpLoadToken;
  container.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const win = document.getElementById('xp-window').value;
    const region = document.getElementById('xp-games-region').value;
    const q = '/api/xp-gain/games?window=' + encodeURIComponent(win) +
      (region ? '&region=' + encodeURIComponent(region) : '') + xpExcludeQuery();
    const data = await get(q);
    if (token !== xpLoadToken) return;
    populateXpRegionFilter(data.regions || []);
    setXpRegions(data.regions || []);
    renderXpGames(data.games || []);
  } catch (e) {
    if (token !== xpLoadToken) return;
    container.innerHTML = '<div class="empty">Failed to load games.</div>';
  }
}

function populateXpRegionFilter(regions) {
  const sel = document.getElementById('xp-games-region');
  if (!sel) return;
  const cur = sel.value;
  let html = '<option value="">All regions</option>';
  for (const r of regions) html += '<option value="' + esc(r) + '">' + esc(r) + '</option>';
  sel.innerHTML = html;
  sel.value = cur; // keep the current selection if it still exists
}

// ── XP-Gain exclusion filters ──────────────────────────────────────────────
// Excluded tags/servers are sent to the server, which drops the matching rows before
// ranking — so both sub-tabs stay internally consistent (no gaps in the top-N, and
// totals that match what's listed).

const XP_TAGS = ['sus', 'botted', 'removed', 'banned'];
const xpExcludedTags    = new Set();
const xpExcludedRegions = new Set();
let   xpKnownRegions    = [];

/** Query-string fragment for the current exclusions (empty when nothing is excluded). */
function xpExcludeQuery() {
  let q = '';
  if (xpExcludedTags.size)    q += '&excludeTags=' + encodeURIComponent([...xpExcludedTags].join(','));
  if (xpExcludedRegions.size) q += '&excludeRegions=' + encodeURIComponent([...xpExcludedRegions].join(','));
  return q;
}

function xpCheckbox(group, value, label, checked) {
  return '<label><input type="checkbox" data-xpex="' + group + '" value="' + esc(value) + '"' +
    (checked ? ' checked' : '') + '>' + label + '</label>';
}

function renderXpExcludePanel() {
  document.getElementById('xp-exclude-tags').innerHTML =
    XP_TAGS.map(function (t) {
      return xpCheckbox('tag', t, modBadge(t) || '<span class="badge badge-perm">BANNED</span>', xpExcludedTags.has(t));
    }).join('');

  document.getElementById('xp-exclude-regions').innerHTML = xpKnownRegions.length
    ? xpKnownRegions.map(function (r) { return xpCheckbox('region', r, esc(r), xpExcludedRegions.has(r)); }).join('')
    : '<span class="empty-note">No servers in this window.</span>';

  const n = xpExcludedTags.size + xpExcludedRegions.size;
  const badge = document.getElementById('xp-exclude-count');
  badge.textContent = n ? ' (' + n + ')' : '';
  document.getElementById('xp-exclude-btn').classList.toggle('btn-orange', n > 0);
}

/** Keeps the known-region list fresh from whichever XP endpoint answered last. */
function setXpRegions(regions) {
  const next = regions || [];
  if (next.join('|') === xpKnownRegions.join('|')) return;
  xpKnownRegions = next;
  // Drop exclusions for servers that no longer appear, so a stale filter can't
  // silently keep hiding rows the moderator can no longer see or untick.
  for (const r of [...xpExcludedRegions]) if (!next.includes(r)) xpExcludedRegions.delete(r);
  renderXpExcludePanel();
}

document.getElementById('xp-exclude-btn').addEventListener('click', function () {
  const panel = document.getElementById('xp-exclude-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('xp-exclude-panel').addEventListener('change', function (e) {
  const cb = e.target.closest('[data-xpex]');
  if (!cb) return;
  const set = cb.dataset.xpex === 'tag' ? xpExcludedTags : xpExcludedRegions;
  if (cb.checked) set.add(cb.value); else set.delete(cb.value);
  renderXpExcludePanel();
  refreshXp();
});

document.getElementById('xp-exclude-clear').addEventListener('click', function () {
  if (!xpExcludedTags.size && !xpExcludedRegions.size) return;
  xpExcludedTags.clear();
  xpExcludedRegions.clear();
  renderXpExcludePanel();
  refreshXp();
});

function modBadge(status) {
  if (status === 'botted')  return '<span class="badge badge-botted">BOTTED</span>';
  if (status === 'sus')     return '<span class="badge badge-sus">SUS</span>';
  if (status === 'removed') return '<span class="badge badge-removed">REMOVED</span>';
  return '';
}

// The sus / botted / clear buttons for one (game, player). The current status hides
// the redundant button. Moderators get "sus" plus "clear" for a sus label — never
// "botted", and never a clear that would restore XP from a botted/removed row.
function modActionsInner(gameId, userId, status, name, guest) {
  if (!userId) return '';
  function btn(label, st, cls) {
    return '<button class="btn ' + cls + ' btn-sm" data-mod="' + esc(gameId) + '" data-mod-user="' + esc(userId) + '" data-mod-status="' + st + '"' +
      (name ? ' data-mod-name="' + esc(name) + '"' : '') + '>' + label + '</button>';
  }
  // A guest owns no account and earns no XP, so "botted" is meaningless for them —
  // the server rejects it too. Sus (a label) is all that applies.
  const isGuest = guest || String(userId).indexOf('guest:') === 0;
  const parts = [];
  if (status !== 'sus')                          parts.push(btn('sus', 'sus', 'btn-orange'));
  if (isAdmin && !isGuest && status !== 'botted') parts.push(btn('botted', 'botted', 'btn-red'));
  if (status && (isAdmin || status === 'sus'))    parts.push(btn('clear', 'clear', 'btn-gray'));
  return parts.join('');
}

// Per-player roster actions: a removed player only offers Restore; otherwise the
// sus/botted/clear controls plus "Remove" (detach from stats + leaderboard).
function rosterActionsInner(gameId, userId, status, removed, name, guest) {
  if (!userId) return '';
  if (removed) {
    // Restoring re-grants XP — admins only.
    return isAdmin
      ? '<button class="btn btn-blue btn-sm" data-restoreuser="' + esc(gameId) + '" data-ruser="' + esc(userId) + '" title="Re-attach this player and restore their XP">↩ Restore</button>'
      : '';
  }
  const isGuest = guest || String(userId).indexOf('guest:') === 0;
  return modActionsInner(gameId, userId, status, name, isGuest) +
    // "Remove" detaches an ACCOUNT from the game; a guest has none to detach.
    (isAdmin && !isGuest
      ? ' <button class="btn btn-orange btn-sm" data-removeuser="' + esc(gameId) + '" data-ruser="' + esc(userId) + '" title="Remove this player from the game — hides it from their stats and the leaderboard and revokes its XP">➖ Remove</button>'
      : '');
}

// Re-fetches and re-renders one expanded game roster (after a remove/restore).
async function refreshRoster(wrap, gameId) {
  try {
    const data = await get('/api/game/' + encodeURIComponent(gameId) + '/players');
    wrap.innerHTML = renderGameRoster(data);
  } catch (e) { /* leave the current roster in place */ }
}

async function doRemoveUser(gameId, userId, btn) {
  const ok = await askConfirm({
    title: '➖ Remove player from game',
    body: 'The game will no longer appear in their stats or the leaderboard, and the XP they gained from it is revoked. ' +
      'The game itself and the other players are kept.<br><br>This can be undone with <strong style="color:var(--text)">Restore</strong>.',
    confirmLabel: '➖ Remove player',
    confirmClass: 'btn-orange',
  });
  if (!ok) return;
  try {
    await post('/api/game/' + encodeURIComponent(gameId) + '/remove-user', { userId: userId });
    toast('Player removed from game — XP revoked');
    // btn is null when called from a view with no roster to refresh (e.g. the Sus tab).
    const wrap = btn && btn.closest('.xp-detail-wrap');
    if (wrap) refreshRoster(wrap, gameId);
  } catch (e) {
    toast('Remove failed: ' + e.message, true);
  }
}

async function doRestoreUser(gameId, userId, btn) {
  try {
    await post('/api/game/' + encodeURIComponent(gameId) + '/restore-user', { userId: userId });
    toast('Player restored to game — XP restored');
    const wrap = btn.closest('.xp-detail-wrap');
    if (wrap) refreshRoster(wrap, gameId);
  } catch (e) {
    toast('Restore failed: ' + e.message, true);
  }
}

function renderXpGames(games) {
  const container = document.getElementById('xp-games-container');
  if (!games.length) { container.innerHTML = '<div class="empty">No games in this window.</div>'; return; }
  let rows = '';
  for (let i = 0; i < games.length; i++) rows += xpGameRowHtml(games[i], i);
  container.innerHTML =
    '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">Click a row to expand the full game. Ctrl+click a name or replay to open it in a new tab.</div>' +
    '<table class="data-table">' +
    '<thead><tr><th>#</th><th>Player</th><th>Map · Mode</th><th>Region</th><th title="Distinct players in the game — low counts hint at a bot lobby">Players</th><th>K</th><th>Dmg</th><th>Rank</th><th>Alive</th><th>XP</th><th>Status</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

function xpGameRowHtml(g, i) {
  const mode = TEAM_MODE_LABEL[g.teamMode] || ('Mode ' + g.teamMode);
  const nameLabel = esc(g.username || g.slug || '(guest / unlinked)');
  const nameCell = g.slug
    ? adminNavLink(hAccount(g.slug), nameLabel, { title: 'Open account' })
    : '<span style="color:var(--text-muted)">' + nameLabel + '</span>';
  const banned = g.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
  const key = g.gameId + '|' + g.userId;
  return '<tr class="xp-game-row" data-gid="' + esc(g.gameId) + '" data-uid="' + esc(g.userId) + '" style="cursor:pointer" title="Click to expand this game">' +
    '<td style="color:var(--text-dim)">#' + (i + 1) + '</td>' +
    '<td>' + nameCell + banned + '</td>' +
    '<td>' + esc(g.mapName) + ' · ' + mode + '</td>' +
    '<td>' + esc(g.region || '–') + '</td>' +
    '<td>' + (g.players != null ? g.players : '–') + '</td>' +
    '<td>' + g.kills + '</td>' +
    '<td>' + g.damage + '</td>' +
    '<td>' + g.rank + '</td>' +
    '<td>' + fmtSecs(g.timeAlive) + '</td>' +
    '<td><strong>' + g.xp.toLocaleString() + '</strong></td>' +
    '<td><span class="xp-modcell" data-key="' + esc(key) + '">' + modBadge(g.modStatus) + '</span></td>' +
    '<td style="white-space:nowrap;">' +
      navLink(hReplays(g.gameId), '▶ replay', { title: 'Open this game in the Replays tab' }) +
      '<span class="xp-modacts" data-key="' + esc(key) + '">' + modActionsInner(g.gameId, g.userId, g.modStatus, g.username || g.slug) + '</span>' +
    '</td>' +
  '</tr>';
}

// Expand / collapse a game row into a full roster of every player in the game.
async function toggleGameExpand(row) {
  const gid = row.dataset.gid;
  const next = row.nextElementSibling;
  if (next && next.classList.contains('xp-detail-row')) { next.remove(); return; }
  const colspan = row.children.length;
  const detail = document.createElement('tr');
  detail.className = 'xp-detail-row';
  detail.innerHTML = '<td colspan="' + colspan + '"><div class="xp-detail-wrap"><div class="loading">Loading game…</div></div></td>';
  row.after(detail);
  const wrap = detail.querySelector('.xp-detail-wrap');
  try {
    const data = await get('/api/game/' + encodeURIComponent(gid) + '/players');
    wrap.innerHTML = renderGameRoster(data);
  } catch (e) {
    wrap.innerHTML = '<div class="empty">Failed to load game.</div>';
  }
}

function renderGameRoster(data) {
  const players = data.players || [];
  if (!players.length) return '<div class="empty">No player data for this game.</div>';
  const m = data.meta;
  const metaHtml = m
    ? '<div style="font-size:11px;color:var(--text-dim);">' + esc(m.mapName) + ' · ' + (TEAM_MODE_LABEL[m.teamMode] || ('Mode ' + m.teamMode)) + ' · ' + esc(m.region || '') + ' · ' + fmtDate(m.createdAt) + ' · <span style="font-family:monospace">' + esc(data.gameId) + '</span></div>'
    : '';
  const header =
    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">' + metaHtml +
    (isAdmin
      ? '<button class="btn btn-red btn-sm" data-delgame="' + esc(data.gameId) + '" style="margin-left:auto;" title="Permanently delete this whole game from stats, leaderboard and match history">🗑 Delete game</button>'
      : '') +
    '</div>';
  let rows = '';
  for (const p of players) {
    const nameCell = playerIpCell(p, '(guest)');
    const banned = p.banned ? ' <span class="badge badge-perm">BAN</span>' : '';
    // Actions target the mod key, so a guest (no account) can still be flagged.
    const key = data.gameId + '|' + (p.modKey || p.userId);
    const badge = p.removed ? modBadge('removed') : modBadge(p.modStatus);
    rows +=
      '<tr' + (p.removed ? ' style="opacity:.55"' : '') + '>' +
      '<td>' + nameCell + banned + '</td>' +
      '<td>' + (p.encodedIp ? ipLink(p.encodedIp) : '<span style="color:var(--text-muted)">–</span>') + '</td>' +
      '<td>' + p.kills + '</td>' +
      '<td>' + p.assists + '</td>' +
      '<td>' + p.damage + '</td>' +
      '<td>' + p.damageTaken + '</td>' +
      '<td>' + p.rank + '</td>' +
      '<td>' + fmtSecs(p.timeAlive) + '</td>' +
      '<td><strong>' + p.xp.toLocaleString() + '</strong></td>' +
      '<td><span class="xp-modcell" data-key="' + esc(key) + '">' + badge + '</span></td>' +
      '<td style="white-space:nowrap;"><span class="xp-modacts" data-key="' + esc(key) + '">' + rosterActionsInner(data.gameId, p.modKey || p.userId, p.modStatus, p.removed, p.username || p.slug, p.guest) + '</span></td>' +
      '</tr>';
  }
  return header +
    '<table class="data-table">' +
    '<thead><tr><th>Player</th><th title="The IP this player used in this game">IP</th><th>K</th><th>A</th><th>Dmg</th><th>Taken</th><th>Rank</th><th>Alive</th><th>XP</th><th>Status</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

// Apply a moderation action, then patch every place that shows this (game, player).
// A "sus" flag is a note to the rest of the staff, so it always carries a reason —
// the admin-only Sus tab lists it verbatim next to who raised it.
async function doGameModerate(gameId, userId, status, label) {
  let note = '';
  if (status === 'sus') {
    // Always a single player here, so fall back to a generic noun rather than letting
    // an unnamed account read as the whole-game flag.
    note = await askSusReason(susTargetLabel(label || 'this account', gameId));
    if (note === null) return;
  }
  try {
    const res = await post('/api/game/' + encodeURIComponent(gameId) + '/moderate', { userId: userId, status: status, note: note });
    updateModUI(gameId, userId, res.status || null, label);
    toast(status === 'botted' ? 'Player botted — XP, cosmetics and fries revoked'
        : status === 'clear'  ? 'Cleared — XP, cosmetics and fries restored'
        : 'Marked as suspicious');
  } catch (e) {
    toast('Moderation failed: ' + e.message, true);
  }
}

// ── Generic dialog ─────────────────────────────────────────────────────────
// The dashboard's replacement for window.confirm / window.prompt. Only one dialog can
// be open at a time, so a single element + one pending resolver is enough.
//
// uiDialog() is the core; askConfirm() and askInput() are the two shapes callers use.
// It resolves with the field's value ('' when there is no field) on confirm, or null on
// cancel — so "cancelled" is always distinguishable from "confirmed with empty input".

const uiModal = document.getElementById('ui-modal');
let uiModalResolve = null;
let uiModalOpts = null;

/**
 * opts: { title, body?, confirmLabel?, confirmClass?, field?, requireText? }
 *   body        already-escaped HTML shown above the field
 *   field       { multiline?, type?, value?, placeholder?, maxlength?, hint?,
 *                 required?, requiredMsg? }
 *   requireText confirm stays disabled until the field matches this exactly
 * Resolves: string (field value, '' if no field) on confirm | null on cancel.
 */
function uiDialog(opts) {
  // A second call while one is open would strand the first promise — resolve it first.
  if (uiModalResolve) closeUiModal(null);
  uiModalOpts = opts || {};
  const field = uiModalOpts.field;

  document.getElementById('ui-modal-title').innerHTML = uiModalOpts.title || '';
  const bodyEl = document.getElementById('ui-modal-body');
  bodyEl.innerHTML = uiModalOpts.body || '';
  bodyEl.style.display = uiModalOpts.body ? '' : 'none';

  const confirmBtn = document.getElementById('ui-modal-confirm');
  confirmBtn.textContent = uiModalOpts.confirmLabel || 'OK';
  confirmBtn.className = 'btn ' + (uiModalOpts.confirmClass || 'btn-red');

  const wrap = document.getElementById('ui-modal-field');
  const ta = document.getElementById('ui-modal-textarea');
  const input = document.getElementById('ui-modal-input');
  wrap.style.display = field ? '' : 'none';
  ta.style.display = 'none';
  input.style.display = 'none';

  let active = null;
  if (field) {
    active = field.multiline ? ta : input;
    active.style.display = '';
    active.value = field.value != null ? String(field.value) : '';
    active.placeholder = field.placeholder || '';
    if (!field.multiline) active.type = field.type || 'text';
    if (field.maxlength) active.setAttribute('maxlength', String(field.maxlength));
    else active.removeAttribute('maxlength');
    document.getElementById('ui-modal-label').textContent = field.label || '';
    document.getElementById('ui-modal-hint').textContent = field.hint || '';
  }
  uiModalOpts._active = active;

  document.getElementById('ui-modal-keys').textContent = field && field.multiline
    ? 'Enter to confirm · Shift+Enter for a new line · Esc to cancel'
    : 'Enter to confirm · Esc to cancel';

  syncUiModalField();
  uiModal.style.display = 'flex';
  (active || confirmBtn).focus();
  return new Promise(function (resolve) { uiModalResolve = resolve; });
}

/** Keeps the char counter and the requireText gate in sync with the field. */
function syncUiModalField() {
  const opts = uiModalOpts || {};
  const active = opts._active;
  const count = document.getElementById('ui-modal-count');
  const confirmBtn = document.getElementById('ui-modal-confirm');

  count.textContent = active && opts.field && opts.field.maxlength
    ? active.value.length + '/' + opts.field.maxlength
    : '';

  // A destructive action gated on typing an exact string (e.g. an account slug).
  const locked = !!opts.requireText && (!active || active.value.trim() !== opts.requireText);
  confirmBtn.style.opacity = locked ? '.45' : '';
  confirmBtn.style.pointerEvents = locked ? 'none' : '';
}

function closeUiModal(result) {
  uiModal.style.display = 'none';
  const resolve = uiModalResolve;
  uiModalResolve = null;
  uiModalOpts = null;
  if (resolve) resolve(result);
}

function submitUiModal() {
  const opts = uiModalOpts || {};
  const active = opts._active;
  if (!active) { closeUiModal(''); return; }

  const value = active.value.trim();
  if (opts.requireText && value !== opts.requireText) {
    toast(opts.requireMsg || 'Confirmation text does not match', true);
    return;
  }
  if (opts.field && opts.field.required && !value) {
    toast(opts.field.requiredMsg || 'This field is required', true);
    return;
  }
  closeUiModal(value);
}

document.getElementById('ui-modal-textarea').addEventListener('input', syncUiModalField);
document.getElementById('ui-modal-input').addEventListener('input', syncUiModalField);
document.getElementById('ui-modal-cancel').addEventListener('click', function () { closeUiModal(null); });
document.getElementById('ui-modal-confirm').addEventListener('click', submitUiModal);
// Dismiss by clicking the backdrop itself (not the dialog inside it).
uiModal.addEventListener('mousedown', function (e) { if (e.target === uiModal) closeUiModal(null); });
// Enter confirms (Shift+Enter keeps the newline in a textarea); Esc cancels.
uiModal.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') { e.preventDefault(); closeUiModal(null); }
  else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitUiModal(); }
});

/** Yes/no dialog. Resolves true when confirmed. Replaces window.confirm. */
async function askConfirm(opts) {
  return (await uiDialog(opts)) !== null;
}

/** Single-field dialog. Resolves the trimmed value, or null. Replaces window.prompt. */
function askInput(opts) {
  return uiDialog(opts);
}

/** Asks for a sus reason. Resolves with the trimmed reason, or null when cancelled. */
function askSusReason(targetLabel) {
  return askInput({
    title: '⚑ Mark as suspicious',
    body: targetLabel,
    confirmLabel: '⚑ Mark sus',
    confirmClass: 'btn-orange',
    field: {
      label: 'Reason',
      multiline: true,
      maxlength: 500, // matches the server's z.string().max(500)
      placeholder: 'What looks wrong? e.g. aimbot-like snaps at 0:42',
      hint: 'Shown in the Sus tab next to your name.',
      required: true,
      requiredMsg: 'A reason is required to mark something suspicious',
    },
  });
}

/** Builds the "Flagging …" line for the sus dialog. All interpolations are escaped. */
function susTargetLabel(name, gameId) {
  const who = name
    ? 'player <strong style="color:var(--text)">' + esc(name) + '</strong>'
    : '<strong style="color:var(--text)">the whole game</strong>';
  return 'Flagging ' + who + ' · <span style="font-family:monospace;font-size:11px;">' + esc(gameId) + '</span>';
}

function updateModUI(gameId, userId, status, name) {
  const key = gameId + '|' + userId;
  document.querySelectorAll('.xp-modcell').forEach(function (el) { if (el.dataset.key === key) el.innerHTML = modBadge(status); });
  document.querySelectorAll('.xp-modacts').forEach(function (el) { if (el.dataset.key === key) el.innerHTML = modActionsInner(gameId, userId, status, name); });
}

// Removes every list row (and its expanded detail) for a game after it is deleted.
function removeGameFromList(gameId) {
  document.querySelectorAll('.xp-game-row').forEach(function (row) {
    if (row.dataset.gid !== gameId) return;
    const next = row.nextElementSibling;
    if (next && next.classList.contains('xp-detail-row')) next.remove();
    row.remove();
  });
}

// Permanently deletes a game (revokes its XP too). Reviewed from the expanded roster.
async function doDeleteGame(gameId) {
  const ok = await askConfirm({
    title: '🗑 Permanently delete this game',
    body: 'All its match rows are removed from the leaderboard, stats and match history, and the XP ' +
      '(plus cosmetics and fries) every player gained from it is revoked.<br><br>' +
      '<strong style="color:var(--red-t)">This cannot be undone.</strong>',
    confirmLabel: '🗑 Delete game',
    confirmClass: 'btn-red',
  });
  if (!ok) return;
  try {
    const res = await post('/api/game/' + encodeURIComponent(gameId) + '/delete', {});
    toast('Game deleted — ' + res.rowsDeleted + ' rows, ' + res.xpRemoved + ' XP revoked from ' + res.players + ' player(s)');
    removeGameFromList(gameId);
    // If this was the leaderboard's single-game view, return to the leaderboard.
    const lbc = document.getElementById('lb-container');
    if (lbc && lbc.dataset.openGame === gameId) loadLeaderboard();
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

// Delegated clicks for the Games sub-tab: moderation buttons first, then row-expand.
// (Cross-nav links carry data-nav and are handled by the capture-phase nav handler.)
document.addEventListener('click', function (e) {
  const removeBtn = e.target.closest('[data-removeuser]');
  if (removeBtn) {
    e.stopPropagation();
    doRemoveUser(removeBtn.dataset.removeuser, removeBtn.dataset.ruser, removeBtn);
    return;
  }
  const restoreBtn = e.target.closest('[data-restoreuser]');
  if (restoreBtn) {
    e.stopPropagation();
    doRestoreUser(restoreBtn.dataset.restoreuser, restoreBtn.dataset.ruser, restoreBtn);
    return;
  }
  const delBtn = e.target.closest('[data-delgame]');
  if (delBtn) {
    e.stopPropagation();
    doDeleteGame(delBtn.dataset.delgame);
    return;
  }
  const modBtn = e.target.closest('[data-mod]');
  if (modBtn) {
    e.stopPropagation();
    doGameModerate(modBtn.dataset.mod, modBtn.dataset.modUser, modBtn.dataset.modStatus, modBtn.dataset.modName);
    return;
  }
  const row = e.target.closest('.xp-game-row');
  if (!row) return;
  if (e.target.closest('[data-nav]')) return; // let the name / replay links act
  toggleGameExpand(row);
});

// ═══════════════════════════════════════════════════════════════════════════
// TAB – LEADERBOARD (competitive stats leaderboard + game deletion)
// Mirrors the public stats leaderboard; drilling into a player reuses the Games
// sub-tab machinery (.xp-game-row expand → full roster → delete).
// ═══════════════════════════════════════════════════════════════════════════

let lbLoadToken = 0;
const LB_TYPE_LABEL = { kills: 'Kills', wins: 'Wins', kpg: 'K/G', most_damage_dealt: 'Max Dmg' };

async function loadLeaderboard() {
  const container = document.getElementById('lb-container');
  const token = ++lbLoadToken;
  container.dataset.openGame = '';
  container.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const type = document.getElementById('lb-type').value;
    const mode = document.getElementById('lb-mode').value;
    const interval = document.getElementById('lb-interval').value;
    const map = document.getElementById('lb-map').value;
    const q = '/api/leaderboard?type=' + encodeURIComponent(type) + '&teamMode=' + encodeURIComponent(mode) + '&interval=' + encodeURIComponent(interval) + (map ? '&mapId=' + encodeURIComponent(map) : '');
    const data = await get(q);
    if (token !== lbLoadToken) return;
    populateLbMaps(data.maps || []);
    renderLeaderboard(data);
  } catch (e) {
    if (token !== lbLoadToken) return;
    container.innerHTML = '<div class="empty">Failed to load leaderboard.</div>';
  }
}

function populateLbMaps(maps) {
  const sel = document.getElementById('lb-map');
  if (!sel) return;
  const cur = sel.value;
  let html = '<option value="">All maps</option>';
  for (const m of maps) html += '<option value="' + m.mapId + '">' + esc(m.name) + '</option>';
  sel.innerHTML = html;
  sel.value = cur;
}

function renderLeaderboard(data) {
  const container = document.getElementById('lb-container');
  const players = data.players || [];
  if (!players.length) { container.innerHTML = '<div class="empty">No data for this filter.</div>'; return; }
  const valLabel = LB_TYPE_LABEL[data.type] || 'Value';
  // Only "Max Damage" rows map to one exact game (the MAX-damage game), so only
  // there do we offer a direct "Open game" jump.
  const isDmg = data.type === 'most_damage_dealt';
  let rows = '';
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const label = esc(p.username || p.slug || '(guest)');
    const nameCell = p.slug ? navLink(hAccount(p.slug), label, { title: 'Open account' }) : '<span style="color:var(--text-muted)">' + label + '</span>';
    const banned = p.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
    const gameCell = isDmg
      ? '<td>' + (p.topGameId
          ? '<button class="btn btn-blue btn-sm" data-lbgame="' + esc(p.topGameId) + '" title="Open the exact game behind this score to review or delete it">Open game</button>'
          : '<span style="color:var(--text-muted)">–</span>') + '</td>'
      : '';
    rows += '<tr class="lb-row" data-lbuser="' + esc(p.userId) + '" data-lbslug="' + esc(p.slug || '') + '" data-lbname="' + esc(label) + '" style="cursor:pointer" title="Open games">' +
      '<td style="color:var(--text-dim)">#' + (i + 1) + '</td>' +
      '<td>' + nameCell + banned + '</td>' +
      '<td><strong>' + p.val.toLocaleString() + '</strong></td>' +
      '<td>' + p.games + '</td>' +
      gameCell +
      '</tr>';
  }
  const hint = isDmg
    ? 'Click a player to open their games, or “Open game” to jump straight to the exact game behind the score.'
    : 'Click a player to open their games.';
  container.innerHTML =
    '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">' + hint + '</div>' +
    '<table class="data-table"><thead><tr><th>#</th><th>Player</th><th>' + esc(valLabel) + '</th><th>Games</th>' + (isDmg ? '<th>Game</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

async function loadLbPlayer(userId, slug, name) {
  const container = document.getElementById('lb-container');
  const token = ++lbLoadToken;
  container.innerHTML = '<div class="loading">Loading player games…</div>';
  try {
    // Reuse the per-user XP endpoint — it returns each game with stats + gameId + region.
    const data = await get('/api/xp-gain/user/' + encodeURIComponent(userId) + '?window=30d');
    if (token !== lbLoadToken) return;
    renderLbPlayer(data, name);
  } catch (e) {
    if (token !== lbLoadToken) return;
    container.innerHTML = '<div class="empty">Failed to load games.</div>';
  }
}

function renderLbPlayer(data, name) {
  const container = document.getElementById('lb-container');
  const games = (data.games || []).slice().reverse();
  const label = esc(name || data.username || data.slug || data.userId);
  const banned = data.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
  const lookup = data.slug ? ' · ' + navLink(hAccount(data.slug), 'open account', { title: 'Open account' }) : '';
  let rows = '';
  for (const g of games) {
    const mode = TEAM_MODE_LABEL[g.teamMode] || ('Mode ' + g.teamMode);
    rows += '<tr class="xp-game-row" data-gid="' + esc(g.gameId) + '" data-uid="' + esc(data.userId) + '" style="cursor:pointer' + (g.removed ? ';opacity:.55' : '') + '" title="Click to expand this game">' +
      '<td style="white-space:nowrap;font-size:11px;">' + fmtDate(g.createdAt) + '</td>' +
      '<td>' + esc(g.region || '–') + '</td>' +
      '<td>' + esc(g.mapName) + ' · ' + mode + (g.removed ? ' ' + modBadge('removed') : '') + '</td>' +
      '<td>' + g.kills + '</td>' +
      '<td>' + g.damage + '</td>' +
      '<td>' + g.rank + '</td>' +
      '<td>' + fmtSecs(g.timeAlive) + '</td>' +
      '<td style="white-space:nowrap;">' + navLink(hReplays(g.gameId), 'replay', { title: 'Open in the Replays tab' }) + '</td>' +
      '</tr>';
  }
  container.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
      '<button class="btn btn-gray btn-sm" id="lb-back-btn">← Back</button>' +
      '<div style="font-size:15px;font-weight:600;">' + label + banned + '</div>' +
      '<div style="font-size:12px;color:var(--text-dim);">' + (data.slug ? '(' + esc(data.slug) + ')' : '') + lookup + '</div>' +
      '<div style="margin-left:auto;font-size:12px;color:var(--text-dim);">' + games.length + ' games (last 30d)</div>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">Click a game to expand the full roster and delete it if botted.</div>' +
    '<table class="data-table"><thead><tr><th>Time</th><th>Region</th><th>Map · Mode</th><th>Kills</th><th>Dmg</th><th>Rank</th><th>Alive</th><th>Replay</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="8" class="empty">No games in the last 30 days.</td></tr>') +
    '</tbody></table>';
  document.getElementById('lb-back-btn').addEventListener('click', loadLeaderboard);
}

// Open the exact game behind a leaderboard row (Max Damage) in an inline roster
// view — which now carries a 🗑 Delete game button — reusing the shared renderer.
async function loadLbGame(gameId) {
  const container = document.getElementById('lb-container');
  const token = ++lbLoadToken;
  container.dataset.openGame = gameId;
  container.innerHTML = '<div class="loading">Loading game…</div>';
  try {
    const data = await get('/api/game/' + encodeURIComponent(gameId) + '/players');
    if (token !== lbLoadToken) return;
    container.innerHTML =
      '<div style="margin-bottom:12px;"><button class="btn btn-gray btn-sm" id="lb-back-btn">← Back to leaderboard</button></div>' +
      renderGameRoster(data);
    document.getElementById('lb-back-btn').addEventListener('click', loadLeaderboard);
  } catch (e) {
    if (token !== lbLoadToken) return;
    container.innerHTML = '<div class="empty">Failed to load game.</div>';
  }
}

// Click a leaderboard row: the "Open game" button jumps to the exact game; the rest
// of the row opens that player's games (nav links keep their own click).
document.addEventListener('click', function (e) {
  const gbtn = e.target.closest('[data-lbgame]');
  if (gbtn) { loadLbGame(gbtn.dataset.lbgame); return; }
  const row = e.target.closest('.lb-row');
  if (!row) return;
  if (e.target.closest('[data-nav]')) return;
  loadLbPlayer(row.dataset.lbuser, row.dataset.lbslug, row.dataset.lbname);
});

document.getElementById('lb-refresh-btn').addEventListener('click', loadLeaderboard);
['lb-type', 'lb-mode', 'lb-interval', 'lb-map'].forEach(function (id) {
  document.getElementById(id).addEventListener('change', loadLeaderboard);
});

// ═══════════════════════════════════════════════════════════════════════════
// TAB – GAMES (search a game by id or filters → full roster with all mod options)
// A game id jumps straight to the roster; otherwise the filtered list renders
// .xp-game-row rows, so the existing expand → roster → bott/remove/delete machinery
// is reused verbatim.
// ═══════════════════════════════════════════════════════════════════════════

const GAME_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function populateGamesMaps(maps) {
  const sel = document.getElementById('games-map');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All maps</option>' +
    maps.map(m => '<option value="' + m.mapId + '">' + esc(m.name) + '</option>').join('');
  sel.value = cur;
}

function renderGamesList(games) {
  const cont = document.getElementById('games-container');
  if (!games.length) { cont.innerHTML = '<div class="empty">No games match.</div>'; return; }
  const rows = games.map(g =>
    '<tr class="xp-game-row" data-gid="' + esc(g.gameId) + '" data-uid="" style="cursor:pointer" title="Click to expand the full roster">' +
      '<td style="font-size:11px;white-space:nowrap;">' + fmtDate(g.createdAt) + '</td>' +
      '<td>' + esc(g.mapName) + ' · ' + (TEAM_MODE_LABEL[g.teamMode] || ('Mode ' + g.teamMode)) + '</td>' +
      '<td>' + esc(g.region || '–') + '</td>' +
      '<td title="Distinct players — low counts hint at a bot lobby">' + g.players + '</td>' +
      '<td>' + g.topKills + '</td>' +
      '<td>' + g.topDamage + '</td>' +
      '<td>' + (g.flagged ? '<span class="badge badge-perm">flagged</span>' : '') + '</td>' +
      '<td style="font-family:monospace;font-size:10px;color:var(--text-muted);">' + esc(g.gameId) + '</td>' +
    '</tr>'
  ).join('');
  cont.innerHTML =
    '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">' + games.length + ' game(s). Click a row to expand the full roster and moderate players.</div>' +
    '<table class="data-table"><thead><tr><th>Time</th><th>Map · Mode</th><th>Region</th><th>Players</th><th>Top K</th><th>Top Dmg</th><th>Flags</th><th>Game ID</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function loadGamesSearch() {
  const cont = document.getElementById('games-container');
  const raw = document.getElementById('games-search').value.trim();

  // Exact game id → jump straight to its roster (all info + all actions).
  if (GAME_ID_RE.test(raw)) {
    cont.innerHTML = '<div class="loading">Loading game…</div>';
    try {
      const data = await get('/api/game/' + encodeURIComponent(raw) + '/players');
      cont.innerHTML = data.meta
        ? renderGameRoster(data)
        : '<div class="empty">No game found with that ID.</div>';
    } catch (e) { cont.innerHTML = '<div class="empty">Failed to load game.</div>'; }
    return;
  }

  // Otherwise: filtered list of recent games (raw, if any, is an in-game name or slug).
  cont.innerHTML = '<div class="loading">Searching…</div>';
  const p = new URLSearchParams();
  if (raw) p.set('player', raw);
  const map  = document.getElementById('games-map').value;   if (map)  p.set('mapId', map);
  const mode = document.getElementById('games-mode').value;  if (mode) p.set('teamMode', mode);
  p.set('window', document.getElementById('games-window').value);
  const mk = document.getElementById('games-minkills').value; if (mk) p.set('minKills', mk);
  const md = document.getElementById('games-mindmg').value;   if (md) p.set('minDamage', md);
  try {
    const data = await get('/api/games/search?' + p.toString());
    populateGamesMaps(data.maps || []);
    // Now that the box also matches in-game names, "not found" means no games matched
    // the term at all — not that the slug is unknown.
    if (data.unknownPlayer) { cont.innerHTML = '<div class="empty">No games found for that in-game name or slug in this window.</div>'; return; }
    renderGamesList(data.games || []);
  } catch (e) { cont.innerHTML = '<div class="empty">Search failed.</div>'; }
}

document.getElementById('games-search-btn').addEventListener('click', loadGamesSearch);
document.getElementById('games-search').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') loadGamesSearch();
});
['games-map', 'games-mode', 'games-window'].forEach(function (id) {
  document.getElementById(id).addEventListener('change', loadGamesSearch);
});

// ═══════════════════════════════════════════════════════════════════════════
// TAB – SUS (admin-only queue of everything staff flagged as suspicious)
// Unlike Warnings (heuristics), every row here was raised by hand — from the Replays
// tab, the XP Gain tab or a game roster — and carries a reason plus its author.
// ═══════════════════════════════════════════════════════════════════════════

let susData = [];

async function loadSus() {
  const container = document.getElementById('sus-container');
  container.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await get('/api/sus');
    susData = data.entries ?? [];
    renderSus();
  } catch (e) {
    container.innerHTML = '<div class="empty">Failed to load sus flags.</div>';
  }
}

function renderSus() {
  const container = document.getElementById('sus-container');
  const q = document.getElementById('sus-search').value.trim().toLowerCase();
  const entries = q
    ? susData.filter(function (e) {
        const hay = [e.username, e.slug, e.reason, e.markedByName, e.markedBy, e.gameId, e.region]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
    : susData;

  if (!entries.length) {
    container.innerHTML = susData.length
      ? '<div class="empty">No flags match.</div>'
      : '<div class="empty">Nothing is flagged as suspicious.</div>';
    return;
  }

  const rows = entries.map(function (e) {
    const scopeBadge = e.scope === 'game'
      ? '<span class="badge badge-spec">WHOLE GAME</span>'
      : e.scope === 'guest'
        ? '<span class="badge badge-spec">GUEST</span>'
        : '<span class="badge badge-sus">PLAYER</span>';
    // Same cell as the game roster: the name goes to the IP this player used in the
    // flagged game, the slug to their account. A game-wide flag names no player.
    const who = e.scope === 'game'
      ? '<span style="color:var(--text-muted)">— whole game —</span>'
      : playerIpCell(e, e.userId || '(unknown)');
    const banned = e.banned ? ' <span class="badge badge-perm">BANNED</span>' : '';
    const roleBadge = e.markedByRole === 'admin'
      ? ' <span class="badge badge-admin">ADMIN</span>'
      : e.markedByRole === 'moderator' ? ' <span class="badge badge-mod">MOD</span>' : '';
    const meta = e.mapName
      ? esc(e.mapName) + ' · ' + (TEAM_MODE_LABEL[e.teamMode] || ('Mode ' + e.teamMode))
      : '<span style="color:var(--text-muted)">— game deleted —</span>';
    return '<tr>' +
      '<td style="font-size:11px;white-space:nowrap;">' + fmtDate(e.markedAt) + '</td>' +
      '<td>' + scopeBadge + '</td>' +
      '<td>' + who + banned + '</td>' +
      '<td style="max-width:320px;">' + esc(e.reason || '–') + '</td>' +
      '<td style="white-space:nowrap;">' + esc(e.markedByName) + roleBadge + '</td>' +
      '<td>' + meta + '</td>' +
      '<td>' + esc(e.region || '–') + '</td>' +
      '<td style="font-size:11px;white-space:nowrap;color:var(--text-muted);">' + (e.playedAt ? fmtDate(e.playedAt) : '–') + '</td>' +
      '<td>' +
        '<span style="display:inline-flex;gap:5px;align-items:center;flex-wrap:wrap;">' +
          navButton(hGame(e.gameId), '🎮 game', { cls: 'btn-blue', title: 'Open this game in the Games tab (Ctrl+click for a new tab)' }) +
          navButton(hReplays(e.gameId), '▶ replay', { cls: 'btn-blue', title: 'Find this game in the Replays tab (Ctrl+click for a new tab)' }) +
          susRowActions(e) +
          '<button class="btn btn-gray btn-sm" data-susclear="' + esc(e.gameId) + '" data-sususer="' + esc(e.userId || '') + '" title="Remove this sus flag">clear</button>' +
        '</span>' +
      '</td>' +
    '</tr>';
  }).join('');

  container.innerHTML =
    '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">' + entries.length + ' flag(s)' + (q ? ' of ' + susData.length : '') + '.</div>' +
    '<table class="data-table"><thead><tr><th>Flagged</th><th>Scope</th><th>Player</th><th>Reason</th><th>By</th><th>Map · Mode</th><th>Region</th><th>Played</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

/**
 * The enforcement actions available on one sus row. What a flag is about decides what
 * can be done to it, so each button only appears where it actually works:
 *   player → botted + remove (both move XP) + account ban + IP ban
 *   guest  → IP ban only (no account exists to bott, remove or ban)
 *   game   → none of them (the flag names no single player)
 */
function susRowActions(e) {
  const parts = [];
  if (e.scope === 'player') {
    parts.push('<button class="btn btn-red btn-sm" data-susact="botted" data-susgame="' + esc(e.gameId) + '" data-sususer="' + esc(e.userId) + '" title="Void this player\\'s game — revokes its XP, cosmetics and fries">botted</button>');
    parts.push('<button class="btn btn-orange btn-sm" data-susact="remove" data-susgame="' + esc(e.gameId) + '" data-sususer="' + esc(e.userId) + '" title="Remove this player from the game — hides it from their stats and the leaderboard and revokes its XP">➖ remove</button>');
    if (e.slug) {
      parts.push('<button class="btn btn-red btn-sm" data-susact="banacc" data-susslug="' + esc(e.slug) + '" data-susreason="' + esc(e.reason || '') + '" title="Ban this account">🔨 ban acc</button>');
    }
  }
  // A guest has no account, but they do have the IP they played this game from.
  if (e.encodedIp && (e.scope === 'player' || e.scope === 'guest')) {
    parts.push('<button class="btn btn-red btn-sm" data-susact="banip" data-susip="' + esc(e.encodedIp) + '" data-susreason="' + esc(e.reason || '') + '" title="Ban the IP this player used in this game">🔨 ban IP</button>');
  }
  return parts.join('');
}

document.addEventListener('click', function (e) {
  const clr = e.target.closest('[data-susclear]');
  if (clr) { clearSusFlag(clr.dataset.susclear, clr.dataset.sususer || ''); return; }
  const act = e.target.closest('[data-susact]');
  if (act) { runSusAction(act.dataset); }
});

/**
 * Runs an enforcement action from the Sus tab. Reuses the same endpoints and dialogs
 * the Games/XP tabs use, so the rules (and their confirmations) stay in one place.
 *
 * Bans open the prefilled ban modal — which is its own flow — so they don't reload the
 * list; the two game actions do, since they change or remove the flag shown here.
 */
async function runSusAction(d) {
  if (d.susact === 'banacc') {
    openBanModal({ type: 'account', target: d.susslug, reason: d.susreason || '' });
    return;
  }
  if (d.susact === 'banip') {
    openBanModal({ type: 'ip', target: d.susip, reason: d.susreason || '' });
    return;
  }
  if (d.susact === 'botted') {
    // Marking botted replaces the sus flag, so the row leaves this list.
    await doGameModerate(d.susgame, d.sususer, 'botted');
    await loadSus();
    return;
  }
  if (d.susact === 'remove') {
    await doRemoveUser(d.susgame, d.sususer, null);
    await loadSus();
  }
}

async function clearSusFlag(gameId, userId) {
  try {
    await post('/api/game/' + encodeURIComponent(gameId) + '/moderate', { userId: userId, status: 'clear', note: '' });
    susData = susData.filter(function (e) { return !(e.gameId === gameId && (e.userId || '') === userId); });
    renderSus();
    toast('Sus flag cleared');
  } catch (e) { toast('Failed to clear: ' + e.message, true); }
}

document.getElementById('sus-refresh-btn').addEventListener('click', loadSus);
document.getElementById('sus-search').addEventListener('input', renderSus);

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
      <td>\${!b.banExpiresAt ? '<span class="badge badge-perm">PERMANENT</span>' : '<span class="badge badge-temp">TEMP</span>'}</td>
      <td>\${!b.banExpiresAt ? '∞' : fmtDate(b.banExpiresAt)}</td>
      <td>
        <button class="btn btn-green btn-sm" onclick="unbanAccount('\${esc(b.slug)}')">Unban</button>
        <button class="btn btn-gray btn-sm" onclick="toggleBanComments('account','\${esc(b.slug)}', this)">💬</button>
      </td>
    </tr>
  \`).join('') : '<tr><td colspan="7" class="empty">No account bans.</td></tr>';
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
  const targetHint    = document.getElementById('modal-target-hint');
  // Account bans now support an optional duration too, so the block stays visible
  // for every ban type.
  targetHint.textContent = type === 'account' ? '(account slug)' : '(IP hash)';
}

// Enable exactly the inputs that apply: nothing when Permanent, otherwise the
// "For <n> <unit>" fields or the "Until <datetime>" picker per the selected mode.
function syncBanDurationInputs() {
  const perm = document.getElementById('modal-ban-perm').checked;
  const modeEl = document.querySelector('input[name="modal-ban-mode"]:checked');
  const mode = modeEl ? modeEl.value : 'duration';
  document.querySelectorAll('input[name="modal-ban-mode"]').forEach(r => { r.disabled = perm; });
  document.getElementById('modal-ban-days').disabled  = perm || mode !== 'duration';
  document.getElementById('modal-ban-unit').disabled  = perm || mode !== 'duration';
  document.getElementById('modal-ban-until').disabled = perm || mode !== 'until';
}

const banModal = document.getElementById('ban-modal');

/**
 * Opens the ban modal, reset to a known state and prefilled for the given target.
 * opts: { type: 'ip'|'account'|'chat', target?, reason?, kickTarget? }
 *   kickTarget — a player name; makes the confirm handler ALSO ban that account and
 *                kick them from the running game (used by the live-server quick ban).
 */
function openBanModal(opts) {
  opts = opts || {};
  delete banModal.dataset.kickTarget;
  if (opts.kickTarget) banModal.dataset.kickTarget = opts.kickTarget;
  document.getElementById('modal-ban-target').value = opts.target || '';
  document.getElementById('modal-ban-reason').value = opts.reason || '';
  document.getElementById('modal-ban-days').value   = '7';
  document.getElementById('modal-ban-unit').value   = 'days';
  document.getElementById('modal-ban-until').value  = '';
  document.getElementById('modal-ban-perm').checked = false;
  document.querySelector('input[name="modal-ban-mode"][value="duration"]').checked = true;
  syncBanDurationInputs();
  document.getElementById('modal-ban-type').value   = opts.type || 'ip';
  onBanTypeChange();
  banModal.style.display = 'flex';
}

document.getElementById('ban-new-btn').addEventListener('click', () => openBanModal({ type: 'ip' }));

document.getElementById('modal-cancel-btn').addEventListener('click', () => { banModal.style.display = 'none'; });

document.getElementById('modal-confirm-btn').addEventListener('click', async () => {
  const type   = document.getElementById('modal-ban-type').value;
  const target = document.getElementById('modal-ban-target').value.trim();
  const reason = document.getElementById('modal-ban-reason').value.trim();
  const perm   = document.getElementById('modal-ban-perm').checked;
  const modeEl = document.querySelector('input[name="modal-ban-mode"]:checked');
  const mode   = modeEl ? modeEl.value : 'duration';
  if (!target) return toast('Please specify a target!', true);

  // days = (fractional) days for the server's fallback + log; expiresAt = an absolute
  // epoch-ms end time that overrides it when the admin picked an exact date & time.
  let days = 36500; // permanent sentinel
  let expiresAt;
  if (!perm) {
    if (mode === 'until') {
      const raw = document.getElementById('modal-ban-until').value;
      const t = raw ? new Date(raw).getTime() : NaN;
      if (!Number.isFinite(t)) return toast('Please pick an end date & time!', true);
      if (t <= Date.now()) return toast('End date & time must be in the future!', true);
      expiresAt = t;
      days = (t - Date.now()) / 86400000;
    } else {
      const amount = parseFloat(document.getElementById('modal-ban-days').value) || 0;
      if (amount <= 0) return toast('Please specify a duration!', true);
      const unit = document.getElementById('modal-ban-unit').value;
      const unitDays = unit === 'minutes' ? 1/1440 : unit === 'hours' ? 1/24 : 1;
      days = amount * unitDays;
    }
  }
  try {
    if (type === 'ip')      await post('/api/ban/ip',      { ip: target, reason, duration: days, permanent: perm, expiresAt });
    if (type === 'account') await post('/api/ban/account', { slug: target, reason, duration: days, permanent: perm, expiresAt });
    if (type === 'chat')    await post('/api/ban/chat',    { ip: target, reason, duration: days, permanent: perm, expiresAt });

    // If opened from player list: also ban account + kick the player
    const kickTarget = banModal.dataset.kickTarget;
    if (kickTarget) {
      delete banModal.dataset.kickTarget;
      await post('/api/ban/account', { slug: kickTarget, reason, duration: days, permanent: perm, expiresAt });
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
  document.getElementById('modal-ban-unit').value    = 'days';
  document.getElementById('modal-ban-until').value  = '';
  document.getElementById('modal-ban-perm').checked = false;
  document.querySelector('input[name="modal-ban-mode"][value="duration"]').checked = true;
  syncBanDurationInputs();
  onBanTypeChange();
  banModal.style.display = 'flex';
}

function quickBanChat(hash) {
  // Pre-fill the ban modal as a chat ban (reason/duration editable before confirm).
  openBanModal({ type: 'chat', target: hash });
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
  const ok = await askConfirm({
    title: '⏹ Force-stop this game',
    body: 'Every player still in <span style="font-family:monospace;font-size:11px;">' + esc(gameId) + '</span> is dropped immediately.',
    confirmLabel: '⏹ Force-stop',
    confirmClass: 'btn-red',
  });
  if (!ok) return;
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
    // Status badges: alive/dead + spectator (combined for a player who died and is now
    // spectating); disconnected overrides both. A player who JOINED as a spectator is
    // killed server-side on their first tick, so suppress the meaningless DEAD for them.
    const aliveBadge = p.disconnected
      ? '<span class="badge badge-disc">DISCONNECTED</span>'
      : p.joinedAsSpectator
        ? ''
        : p.alive
          ? '<span class="badge badge-alive">ALIVE</span>'
          : '<span class="badge badge-dead">DEAD</span>';
    const specBadge  = !p.disconnected && p.isSpectator ? '<span class="badge badge-spec">SPECTATOR</span>' : '';
    const adminBadge = p.isAdmin ? '<span class="badge badge-admin">ADMIN</span>'
      : p.isModerator ? '<span class="badge badge-mod">MODERATOR</span>' : '';
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
  // Passing kickTarget makes the confirm handler also ban the account + kick them.
  openBanModal({ type: 'ip', target: hash, kickTarget: name });
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
        \${a.moderator ? '<span class="badge badge-mod">MODERATOR</span>' : ''}
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
  const input = await askInput({
    title: '🍟 Golden Fries',
    body: 'Account <strong style="color:var(--text)">' + esc(slug) + '</strong> · aktuell <strong style="color:var(--text)">' + (current ?? 0) + '</strong> 🍟',
    confirmLabel: 'Übertragen',
    confirmClass: 'btn-orange',
    field: {
      label: 'Betrag',
      type: 'number',
      value: '100',
      hint: 'Negativer Betrag zieht ab.',
      required: true,
      requiredMsg: 'Bitte einen Betrag angeben',
    },
  });
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
    u.moderator ? '<span class="badge badge-mod">MODERATOR</span>' : '',
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
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        \${u.admin
          ? '<span style="font-size:11px;color:var(--orange-t);">🛡 Admin account — cannot be deleted.</span>'
          : (u.moderator
              ? '<button class="btn btn-gray btn-sm" onclick="accSetModerator(false)">Remove moderator</button>'
              : '<button class="btn btn-blue btn-sm" onclick="accSetModerator(true)" title="Grant replays-only dashboard access">🛡 Make moderator</button>') +
            '<button class="btn btn-red btn-sm" onclick="accDeleteAccount()">🗑 Delete Account</button><span style="font-size:10px;color:var(--text-muted);">permanent — removes items, XP, passes, fries &amp; sessions; match history is anonymized</span>'}
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
  // Auction rows: the sale shows the winner; bid/refund are escrow moves.
  const au = e.auction;
  if (au && au.item) {
    const item = esc(cosmeticName(au.item) || au.item);
    if (au.kind === 'sell') {
      const who = au.winnerSlug
        ? navLink(hAccount(au.winnerSlug), esc(au.winnerName || au.winnerSlug), { title: 'Open account' })
        : esc(au.winnerName || 'winner');
      return '🔨 Auction — sold ' + item + ' <span style="color:var(--text-muted)">to</span> ' + who;
    }
    if (au.kind === 'bid') return '🔨 Auction bid <span style="color:var(--text-muted)">on</span> ' + item + ' <span style="color:var(--text-muted)">(escrow)</span>';
    return '🔨 Auction refund <span style="color:var(--text-muted)">· outbid on</span> ' + item;
  }
  // Buy-offer rows: like a market trade but via an accepted offer.
  const of = e.offer;
  if (of && of.item) {
    const item = esc(cosmeticName(of.item) || of.item);
    const who = of.counterpartySlug
      ? navLink(hAccount(of.counterpartySlug), esc(of.counterpartyName || of.counterpartySlug), { title: 'Open account' })
      : esc(of.counterpartyName || 'unknown');
    return of.direction === 'buy'
      ? '💰 Offer — bought ' + item + ' <span style="color:var(--text-muted)">from</span> ' + who
      : '💰 Offer — sold ' + item + ' <span style="color:var(--text-muted)">to</span> ' + who;
  }
  // Golden Fries gift (no item).
  const gf = e.gift;
  if (gf) {
    const who = gf.counterpartySlug
      ? navLink(hAccount(gf.counterpartySlug), esc(gf.counterpartyName || gf.counterpartySlug), { title: 'Open account' })
      : esc(gf.counterpartyName || 'unknown');
    return gf.direction === 'send'
      ? '🎁 Gifted fries <span style="color:var(--text-muted)">to</span> ' + who
      : '🎁 Received fries <span style="color:var(--text-muted)">from</span> ' + who;
  }
  // Market row whose listing no longer exists: it is cascade-deleted when the traded
  // item or the counterparty's account is deleted, so the partner can't be recovered.
  const gone = /^market:(buy|sell):(\d+)$/.exec(e.reason || '');
  if (gone) {
    const verb = gone[1] === 'buy' ? 'Bought' : 'Sold';
    return verb + ' item <span style="color:var(--text-muted)">· listing #' + esc(gone[2]) + ' (counterparty account deleted)</span>';
  }
  const r = e.reason || '';
  const rev = /^revert:(.+)$/.exec(r);
  if (rev) return '<span style="color:var(--text-muted)">↩️ Reverted transaction #' + esc(rev[1]) + '</span>';
  if (r === 'pass:welcome_fries') return 'Welcome fries';
  const pass = /^pass:(.+):level:(\d+)$/.exec(r);
  if (pass) return 'Pass reward · ' + esc(pass[1]) + ' · lvl ' + esc(pass[2]);
  const shop = /^shop:(.+):(\d+)$/.exec(r);
  if (shop) return 'Shop purchase · ' + esc(shop[1]) + ' · slot ' + esc(shop[2]);
  if (/^revoke_pass_fries:/.test(r)) return '<span style="color:var(--text-muted)">Revoked pass fries</span>';
  const adm = /^admin_grant(?::(.+))?$/.exec(r);
  if (adm) return 'Admin grant' + (adm[1] ? ' <span style="color:var(--text-muted)">by ' + esc(adm[1]) + '</span>' : '');
  return esc(r);
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
    const action = e.reverted
      ? '<span class="badge" style="background:var(--surface2);color:var(--text-muted);">reverted</span>'
      : e.revertable
        ? '<button class="btn btn-orange btn-sm" onclick="doRevertGp(' + e.id + ')" title="Revert this transaction (type-specific rollback)">↩ Revert</button>'
        : '';
    return \`<tr\${e.reverted ? ' style="opacity:.55"' : ''}>
      <td style="font-size:11px;white-space:nowrap;">\${fmtDate(e.createdAt)}</td>
      <td style="font-weight:600;white-space:nowrap;color:\${earn ? 'var(--green-t)' : 'var(--red-t)'};">\${earn ? '+' : ''}\${e.amount.toLocaleString()}</td>
      <td style="font-size:11px;">\${gpReason(e)}</td>
      <td style="font-size:11px;color:var(--text-dim);">🍟 \${e.balanceAfter}</td>
      <td style="white-space:nowrap;">\${action}</td>
    </tr>\`;
  }).join('');
  cont.innerHTML = summary + (entries.length
    ? \`<table class="data-table"><thead><tr><th>Date</th><th>Amount</th><th>Reason</th><th>Balance</th><th>Actions</th></tr></thead><tbody>\${rows}</tbody></table>\`
    : '<div class="empty">No GP history for this filter.</div>');
}

// Revert one Golden Fries transaction (pass reward / shop buy / market trade). The
// server does the type-specific rollback; a blocked revert (e.g. item since traded
// away) surfaces its reason as a toast.
async function doRevertGp(id) {
  const ok = await askConfirm({
    title: '↩ Revert Golden Fries transaction',
    body: 'What happens depends on the entry type:' +
      '<ul style="margin:6px 0 0;padding-left:18px;">' +
        '<li><strong style="color:var(--text)">Pass reward</strong>: fries removed, and NOT re-grantable via reconcile.</li>' +
        '<li><strong style="color:var(--text)">Shop buy</strong>: fries refunded, item removed, slot freed.</li>' +
        '<li><strong style="color:var(--text)">Market trade</strong>: buyer refunded, seller charged, item returned to seller.</li>' +
        '<li><strong style="color:var(--text)">Auction (sale row)</strong>: winner refunded, seller charged, item returned to seller.</li>' +
        '<li><strong style="color:var(--text)">Offer</strong>: buyer refunded, seller charged, item returned to seller.</li>' +
        '<li><strong style="color:var(--text)">Fries gift</strong>: sender refunded, recipient charged.</li>' +
        '<li><strong style="color:var(--text)">Admin grant</strong>: the granted amount is simply reversed.</li>' +
      '</ul>' +
      '<div style="margin-top:8px;">Blocked if the item has since been traded/sold away.</div>',
    confirmLabel: '↩ Revert',
    confirmClass: 'btn-orange',
  });
  if (!ok) return;
  try {
    const r = await post('/api/account/gp/' + id + '/revert', {});
    toast('Reverted (' + r.type + ') — ' + r.detail);
    loadAccountGp(currentAccountSlug, document.getElementById('gp-filter').value);
  } catch (e) {
    toast('Revert failed: ' + e.message, true);
  }
}

async function accSetXp(passType) {
  // Level is derived from XP server-side, so we only send the (total) XP.
  const xp = parseFloat(document.getElementById('xp-xp-' + passType).value) || 0;
  try {
    const r = await post('/api/account/set-xp', { slug: currentAccountSlug, passType, xp });
    toast(passType + ' → lvl ' + (r.level ?? '?') +
      ' · items +' + (r.granted ?? 0) + '/-' + (r.revoked ?? 0) +
      ' · fries +' + (r.friesGranted ?? 0) + '/-' + (r.friesRevoked ?? 0));
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
  const ok = await askConfirm({
    title: '🗑 Remove item group',
    body: 'Removes <strong style="color:var(--text)">all</strong> items with source ' +
      '<strong style="color:var(--text)">' + esc(source) + '</strong> from this account.',
    confirmLabel: '🗑 Remove all',
    confirmClass: 'btn-red',
  });
  if (!ok) return;
  try {
    const r = await post('/api/account/remove-item-source', { slug: currentAccountSlug, source });
    toast('Removed ' + (r.removed ?? 0) + ' items (' + source + ')');
    openAccountDetail(currentAccountSlug);
  } catch (e) { toast('Error: ' + e.message, true); }
}

async function accDeleteAccount() {
  const slug = currentAccountSlug;
  const typed = await askInput({
    title: '⚠️ Permanently delete account',
    body: 'This removes <strong style="color:var(--text)">' + esc(slug) + '</strong> — the user, their items, XP, passes, golden fries and sessions. ' +
      'Match history is anonymized. <strong style="color:var(--red-t)">This cannot be undone.</strong>',
    confirmLabel: '🗑 Delete account',
    confirmClass: 'btn-red',
    // Confirm stays locked until the slug is typed exactly.
    requireText: slug,
    requireMsg: 'Slug mismatch — deletion aborted',
    field: {
      label: 'Type the slug to confirm',
      placeholder: slug,
      hint: 'Must match exactly.',
    },
  });
  if (typed === null) return;
  try {
    await post('/api/account/delete', { slug });
    toast('Account "' + slug + '" deleted');
    accountModal.style.display = 'none';
    loadAccounts();
  } catch (e) { toast('Error: ' + (e.message || 'failed'), true); }
}

// Grant / revoke the replays-only moderator role for the open account.
async function accSetModerator(makeMod) {
  try {
    await post('/api/account/moderator', { slug: currentAccountSlug, moderator: makeMod });
    toast(makeMod ? 'Moderator added — replays-only access' : 'Moderator role removed');
    openAccountDetail(currentAccountSlug);
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

/** Tabs a moderator (non-admin) may open. Everything else is hidden for them. */
const MODERATOR_TABS = ['replays', 'xp'];

(async () => {
  try {
    const me = await get('/api/me');
    currentAdminId   = me.id;
    currentAdminSlug = me.slug;
    isAdmin     = !!me.admin;
    isModerator = !!me.moderator && !me.admin;
    document.getElementById('topbar-user').textContent =
      'Logged in as ' + (me.username || me.slug) + (isModerator ? ' · moderator (replays + XP gain)' : '');
  } catch { /* already redirected by server */ }

  renderXpExcludePanel();

  if (isModerator) {
    // Moderators get Replays + XP Gain, and may only mark things sus. Hiding the rest
    // is UX only — the server independently 403s every route they may not reach.
    document.querySelectorAll('.tab-btn').forEach(b => {
      if (!MODERATOR_TABS.includes(b.dataset.tab)) b.style.display = 'none';
    });
    switchTab('replays');
    return;
  }

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
