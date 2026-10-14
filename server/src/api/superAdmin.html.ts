// The page script avoids backticks and "${" so the whole thing can stay one String.raw.
export const superAdminHtml = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Super Admin</title>
<style>
  :root {
    --bg: #101216; --panel: #181b21; --panel2: #1f232b; --border: #2b303a;
    --text: #e6e8ec; --muted: #8a919e; --accent: #c77dff; --ok: #4ade80;
    --warn: #fbbf24; --bad: #f87171; --mod: #4dc9ff; --admin: #ff4d4d; --prem: #f2d63b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--panel); position: sticky; top: 0; z-index: 2; }
  header h1 { margin: 0; font-size: 16px; color: var(--accent); letter-spacing: .5px; }
  header .local { font-size: 12px; color: var(--muted); }
  nav { display: flex; gap: 4px; margin-left: auto; }
  nav button { background: none; border: 1px solid transparent; color: var(--muted); padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; }
  nav button.active { color: var(--text); background: var(--panel2); border-color: var(--border); }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  section { display: none; } section.active { display: block; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 14px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .6px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  input[type=text], input[type=number], select { background: var(--panel2); border: 1px solid var(--border); color: var(--text); padding: 7px 10px; border-radius: 6px; font: inherit; }
  input[type=text] { min-width: 260px; }
  input[type=number] { width: 80px; }
  button.btn { background: var(--panel2); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  button.btn:hover { border-color: var(--muted); }
  button.btn.danger { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .muted { color: var(--muted); }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); cursor: pointer; user-select: none; font-size: 12px; color: var(--muted); }
  .pill.on.owner { color: var(--accent); border-color: var(--accent); }
  .pill.on.admin { color: var(--admin); border-color: var(--admin); }
  .pill.on.moderator { color: var(--mod); border-color: var(--mod); }
  .prem { color: var(--prem); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  .stat { background: var(--panel2); border-radius: 8px; padding: 10px 12px; }
  .stat .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
  .stat .v { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .bar { height: 6px; background: var(--border); border-radius: 3px; margin-top: 6px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--ok); }
  .bar > div.warn { background: var(--warn); } .bar > div.bad { background: var(--bad); }
  pre#log { background: #0b0d10; border: 1px solid var(--border); border-radius: 8px; padding: 12px; height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 12px 0 0; }
  #toast { position: fixed; bottom: 20px; right: 20px; background: var(--panel2); border: 1px solid var(--border); padding: 10px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #toast.show { opacity: 1; } #toast.err { border-color: var(--bad); color: var(--bad); }
  .offline { color: var(--bad); }
</style>
</head>
<body>
<header>
  <h1>SUPER ADMIN</h1>
  <span class="local">local only &middot; 127.0.0.1</span>
  <nav>
    <button data-tab="roles" class="active">Roles</button>
    <button data-tab="server">Server</button>
    <button data-tab="logs">Logs</button>
  </nav>
</header>
<main>
  <section id="tab-roles" class="active">
    <div class="card">
      <h2>Users</h2>
      <div class="row">
        <input type="text" id="user-q" placeholder="Username, slug or id (empty = all staff)">
        <button class="btn" id="user-search">Search</button>
      </div>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>User</th><th>Roles (click to toggle)</th><th>Premium</th><th></th></tr></thead>
        <tbody id="users"></tbody>
      </table>
    </div>
  </section>

  <section id="tab-server">
    <div class="card">
      <h2>API host</h2>
      <div class="grid" id="api-stats"></div>
    </div>
    <div id="regions"></div>
  </section>

  <section id="tab-logs">
    <div class="card">
      <h2>Logs</h2>
      <div class="row">
        <select id="log-file"></select>
        <select id="log-bytes">
          <option value="65536">last 64 KB</option>
          <option value="262144">last 256 KB</option>
          <option value="1048576">last 1 MB</option>
        </select>
        <input type="text" id="log-filter" placeholder="Filter lines">
        <label class="muted"><input type="checkbox" id="log-follow" checked> follow</label>
        <button class="btn" id="log-refresh">Refresh</button>
      </div>
      <pre id="log" class="mono"></pre>
    </div>
  </section>
</main>
<div id="toast"></div>

<script>
var H = { "x-superadmin": "1" };
function api(method, url, body) {
  var opts = { method: method, headers: H };
  if (body !== undefined) {
    opts.headers = { "x-superadmin": "1", "content-type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw new Error(j.error || r.statusText);
      return j;
    });
  });
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function toast(msg, err) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(t._h); t._h = setTimeout(function () { t.className = ""; }, 2500);
}
function fail(e) { toast(e.message || String(e), true); }
function bytes(n) {
  if (n == null) return "-";
  var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + u[i];
}
function dur(s) {
  var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return (d ? d + "d " : "") + h + "h " + m + "m";
}
function stat(k, v, frac) {
  var bar = "";
  if (frac != null) {
    var cls = frac > 0.9 ? "bad" : frac > 0.75 ? "warn" : "";
    bar = '<div class="bar"><div class="' + cls + '" style="width:' + Math.min(100, frac * 100).toFixed(1) + '%"></div></div>';
  }
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div>" + bar + "</div>";
}

// ---- tabs ----
var current = "roles";
document.querySelectorAll("nav button").forEach(function (b) {
  b.onclick = function () {
    current = b.dataset.tab;
    document.querySelectorAll("nav button").forEach(function (x) { x.classList.toggle("active", x === b); });
    document.querySelectorAll("section").forEach(function (s) { s.classList.toggle("active", s.id === "tab-" + current); });
    if (current === "server") loadStatus();
    if (current === "logs") loadLogFiles();
  };
});

// ---- roles ----
var users = {};
function premiumText(u) {
  if (!u.premiumUntil) return '<span class="muted">-</span>';
  var t = new Date(u.premiumUntil);
  if (t.getTime() < Date.now()) return '<span class="muted">expired ' + esc(t.toLocaleDateString()) + "</span>";
  return '<span class="prem">until ' + esc(t.toLocaleDateString()) + "</span>";
}
function renderUser(u) {
  users[u.id] = u;
  var pills = ["owner", "admin", "moderator"].map(function (r) {
    return '<span class="pill ' + r + (u[r] ? " on" : "") + '" data-id="' + esc(u.id) + '" data-role="' + r + '">' + (u[r] ? "&#10003; " : "") + r + "</span>";
  }).join(" ");
  return '<tr id="u-' + esc(u.id) + '">' +
    "<td><b>" + esc(u.username || "(no name)") + '</b>' + (u.banned ? ' <span class="offline">banned</span>' : "") +
    '<div class="muted mono">' + esc(u.slug) + " &middot; " + esc(u.id) + "</div></td>" +
    "<td>" + pills + "</td>" +
    "<td>" + premiumText(u) + "</td>" +
    '<td><div class="row"><input type="number" min="1" value="30" id="pd-' + esc(u.id) + '">' +
    '<button class="btn" data-prem="' + esc(u.id) + '">+ days</button>' +
    '<button class="btn danger" data-premrm="' + esc(u.id) + '">remove</button></div></td></tr>';
}
function searchUsers() {
  var q = document.getElementById("user-q").value.trim();
  api("GET", "/api/users?q=" + encodeURIComponent(q)).then(function (r) {
    users = {};
    document.getElementById("users").innerHTML = r.users.length
      ? r.users.map(renderUser).join("")
      : '<tr><td colspan="4" class="muted">No users found</td></tr>';
  }).catch(fail);
}
function replaceUser(u) {
  var row = document.getElementById("u-" + u.id);
  if (row) row.outerHTML = renderUser(u);
}
document.getElementById("user-search").onclick = searchUsers;
document.getElementById("user-q").onkeydown = function (e) { if (e.key === "Enter") searchUsers(); };
document.getElementById("users").onclick = function (e) {
  var t = e.target.closest("[data-role],[data-prem],[data-premrm]");
  if (!t) return;
  if (t.dataset.role) {
    var u = users[t.dataset.id], role = t.dataset.role, body = {};
    body[role] = !u[role];
    if (!confirm((body[role] ? "Grant " : "Revoke ") + role + " for " + (u.username || u.slug) + "?")) return;
    api("POST", "/api/users/" + encodeURIComponent(u.id) + "/roles", body)
      .then(function (r) { replaceUser(r.user); toast(role + " " + (body[role] ? "granted" : "revoked")); })
      .catch(fail);
  } else if (t.dataset.prem) {
    var days = Number(document.getElementById("pd-" + t.dataset.prem).value);
    api("POST", "/api/users/" + encodeURIComponent(t.dataset.prem) + "/premium", { days: days })
      .then(function (r) { replaceUser(r.user); toast("+" + days + " days premium"); })
      .catch(fail);
  } else if (t.dataset.premrm) {
    if (!confirm("Remove premium?")) return;
    api("POST", "/api/users/" + encodeURIComponent(t.dataset.premrm) + "/premium", { days: 0 })
      .then(function (r) { replaceUser(r.user); toast("Premium removed"); })
      .catch(fail);
  }
};

// ---- server ----
function hostStats(s) {
  var used = s.totalmem - s.freemem;
  var out = stat("Uptime", dur(s.uptimeSec)) +
    stat("Process RSS", bytes(s.rss)) +
    stat("Heap used", bytes(s.heapUsed)) +
    stat("Host RAM", bytes(used) + " / " + bytes(s.totalmem), used / s.totalmem) +
    stat("Load 1/5/15", s.loadavg.map(function (x) { return x.toFixed(2); }).join(" / "), s.loadavg[0] / s.cpus) +
    stat("CPUs", s.cpus);
  if (s.disk) {
    var du = s.disk.total - s.disk.free;
    out += stat("Disk", bytes(du) + " / " + bytes(s.disk.total), du / s.disk.total);
  }
  return out;
}
function renderRegion(r) {
  var s = r.status;
  var head = '<div class="card"><h2>Region ' + esc(r.id) + (s ? "" : ' <span class="offline">offline</span>') + "</h2>";
  if (!s) return head + "</div>";
  var ctrl = '<div class="row" style="margin:12px 0">' +
    '<span class="muted">maxGames</span><input type="number" min="1" max="200" value="' + s.maxGames + '" id="mg-' + esc(r.id) + '">' +
    '<button class="btn" data-maxgames="' + esc(r.id) + '">Apply</button>' +
    '<span class="muted" style="margin-left:16px">verified-only</span>' +
    '<button class="btn" data-verified="' + esc(r.id) + '" data-state="' + (r.verifiedOnly ? "0" : "1") + '">' + (r.verifiedOnly ? "ON - turn off" : "OFF - turn on") + "</button></div>";
  var games = r.games.length
    ? "<table><thead><tr><th>Game</th><th>Mode</th><th>Alive</th><th>Running</th><th></th></tr></thead><tbody>" +
      r.games.map(function (g) {
        var run = g.runtime ? dur(g.runtime) : "-";
        return "<tr><td class=\"mono\">" + esc(g.id) + (g.stopped ? ' <span class="muted">(stopped)</span>' : "") + (g.verifiedOnly ? ' <span class="prem">verified</span>' : "") + "</td>" +
          "<td>" + esc(g.teamMode) + "</td><td>" + esc(g.playerCount) + "</td><td>" + esc(run) + "</td>" +
          "<td>" + (g.stopped ? "" : '<button class="btn danger" data-stop="' + esc(g.id) + '" data-region="' + esc(r.id) + '">Stop</button>') + "</td></tr>";
      }).join("") + "</tbody></table>"
    : '<div class="muted">No running games</div>';
  return head + '<div class="grid">' +
    stat("Players", s.playerCount) +
    stat("Games", s.gameCount + " / " + s.maxGames, s.gameCount / s.maxGames) +
    stat("Mode", s.processMode) +
    hostStats(s) + "</div>" + ctrl + games + "</div>";
}
var statusBusy = false;
function loadStatus() {
  if (statusBusy) return;
  statusBusy = true;
  api("GET", "/api/status").then(function (r) {
    document.getElementById("api-stats").innerHTML = hostStats(r.api) + stat("Host", r.api.hostname);
    var focused = document.activeElement && document.activeElement.id;
    if (!(focused && focused.indexOf("mg-") === 0)) {
      document.getElementById("regions").innerHTML = r.regions.map(renderRegion).join("");
    }
  }).catch(fail).finally(function () { statusBusy = false; });
}
document.getElementById("regions").onclick = function (e) {
  var t = e.target.closest("[data-maxgames],[data-verified],[data-stop]");
  if (!t) return;
  if (t.dataset.maxgames) {
    var v = Number(document.getElementById("mg-" + t.dataset.maxgames).value);
    api("POST", "/api/regions/" + encodeURIComponent(t.dataset.maxgames) + "/max_games", { maxGames: v })
      .then(function (r) { toast(r.ok ? "maxGames = " + v + " (until restart)" : "Failed", !r.ok); loadStatus(); })
      .catch(fail);
  } else if (t.dataset.verified) {
    api("POST", "/api/regions/" + encodeURIComponent(t.dataset.verified) + "/verified", { state: t.dataset.state === "1" })
      .then(function () { toast("Verified-only updated"); loadStatus(); })
      .catch(fail);
  } else if (t.dataset.stop) {
    if (!confirm("Stop game " + t.dataset.stop + "? All players get kicked.")) return;
    api("POST", "/api/regions/" + encodeURIComponent(t.dataset.region) + "/games/" + encodeURIComponent(t.dataset.stop) + "/stop")
      .then(function (r) { toast(r.ok ? "Game stopped" : "Failed", !r.ok); setTimeout(loadStatus, 500); })
      .catch(fail);
  }
};

// ---- logs ----
var logText = "";
function loadLogFiles() {
  api("GET", "/api/logs").then(function (r) {
    var sel = document.getElementById("log-file"), prev = sel.value;
    sel.innerHTML = r.files.map(function (f) {
      return '<option value="' + esc(f.name) + '">' + esc(f.name) + " (" + bytes(f.size) + ")</option>";
    }).join("");
    if (prev && r.files.some(function (f) { return f.name === prev; })) sel.value = prev;
    loadLog();
  }).catch(fail);
}
function renderLog() {
  var f = document.getElementById("log-filter").value.toLowerCase();
  var text = f ? logText.split("\n").filter(function (l) { return l.toLowerCase().indexOf(f) !== -1; }).join("\n") : logText;
  var pre = document.getElementById("log");
  var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = text;
  if (document.getElementById("log-follow").checked && atBottom) pre.scrollTop = pre.scrollHeight;
}
function loadLog() {
  var name = document.getElementById("log-file").value;
  if (!name) { document.getElementById("log").textContent = "No log files"; return; }
  var b = document.getElementById("log-bytes").value;
  api("GET", "/api/logs/" + encodeURIComponent(name) + "?bytes=" + b).then(function (r) {
    logText = (r.truncated ? "... (truncated)\n" : "") + r.text;
    renderLog();
  }).catch(fail);
}
document.getElementById("log-file").onchange = function () {
  var pre = document.getElementById("log"); pre.textContent = ""; loadLog();
  setTimeout(function () { pre.scrollTop = pre.scrollHeight; }, 50);
};
document.getElementById("log-bytes").onchange = loadLog;
document.getElementById("log-filter").oninput = renderLog;
document.getElementById("log-refresh").onclick = loadLogFiles;

setInterval(function () {
  if (document.hidden) return;
  if (current === "server") loadStatus();
  if (current === "logs" && document.getElementById("log-follow").checked) loadLog();
}, 5000);

searchUsers();
</script>
</body>
</html>`;
