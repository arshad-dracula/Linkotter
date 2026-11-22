"use strict";
// Linkotter desktop interface. The layout is built once; the network web lives in a persistent
// stage so its animations never restart, and only the panels around it are re-rendered.

const token = new URLSearchParams(location.hash.slice(1)).get("t") || sessionStorage.getItem("t") || "";
try { sessionStorage.setItem("t", token); } catch (_) {}

const ui = {
  state: null, tab: "network", query: "", busy: false, error: "", allOpen: false,
  showKey: false, form: { server: "", authKey: "" }, sheet: null, pings: {},
  history: [], sending: [], target: "", unseen: 0, xfer: { in: [], out: [] }, hoverTarget: null,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SELF = NetWeb.SELF;

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Linkotter-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

const icons = {
  network: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="3.5" r="1.5"/><circle cx="20" cy="15.5" r="1.5"/><circle cx="4" cy="15.5" r="1.5"/><path d="M12 9.5V5M14.2 13.2l4.4 1.9M9.8 13.2l-4.4 1.9M12 5l8 10.5L4 15.5z"/>',
  drop: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  send: '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m6 12.5 4 4 8-9"/>',
  ...Object.fromEntries(["laptop", "phone", "server"].map((k) => [k, LK_ICONS[k]])),
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${icons[n]}</svg>`;
const otter = (kind, alt = "") => `<img class="mascot ${kind === "float" ? "float" : ""}" src="otter-${kind}.svg" alt="${esc(alt)}">`;

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
function size(n) {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
}
const ms = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + " ms";
function pathChip(d) {
  if (!d.online) return `<span class="chip chip--idle">Offline</span>`;
  const p = d.path, l = p.latencyMs != null ? " · " + ms(p.latencyMs) : "";
  if (p.kind === "direct") return `<span class="chip chip--direct" title="Traffic goes straight between the two devices">Direct${l}</span>`;
  if (p.kind === "peer-relay") return `<span class="chip chip--direct" title="Traffic goes through one of your own office relays">Office relay${l}</span>`;
  if (p.kind === "relay") return `<span class="chip chip--relay" title="No direct route yet; traffic goes through the ${esc(p.via)} relay">Relay${p.via ? " · " + esc(p.via) : ""}${l}</span>`;
  return `<span class="chip chip--idle" title="Online. A route is set up the moment you use it">Ready</span>`;
}

// ---- persistent layout --------------------------------------------------------------------

const $app = document.getElementById("app");
$app.innerHTML = `
  <div class="shell">
    <header class="top"><img src="otter.svg" alt=""><span class="name">Linkotter</span><span class="netpill" id="netpill" hidden></span></header>
    <main>
      <div id="lead"></div>
      <section class="stage" id="stage" hidden><div class="stage-hint" id="stage-hint"></div></section>
      <div id="view" class="stack"></div>
    </main>
  </div>
  <nav class="tabs" id="nav" aria-label="Sections" hidden><div class="cap"><span class="slider"></span></div></nav>
  <div id="sheet"><div class="scrim" data-act="close-sheet"></div><div class="panel" role="dialog" aria-modal="true" aria-label="Device"></div></div>`;
const $lead = document.getElementById("lead"), $view = document.getElementById("view"), $stage = document.getElementById("stage");
const $nav = document.getElementById("nav"), $sheet = document.getElementById("sheet"), $hint = document.getElementById("stage-hint");

const web = new NetWeb($stage, {
  onSelect: (id) => {
    if (ui.tab === "drop" && id !== SELF) {
      const d = ui.state.devices.find((x) => x.id === id);
      if (d && d.canDrop && d.online) { ui.target = id; web.react("send", `Ready for ${d.name}`); render(); return; }
    }
    if (id === SELF) web.react("boop", BOOPS[(Math.random() * BOOPS.length) | 0]);
    openSheet(id);
  },
  onDropFiles: (id, files) => { ui.target = id; sendFiles(files); },
  onDropMiss: () => toast("Drop the files onto a device"),
  onHover: (d) => {
    $stage.classList.toggle("dragging", !!d);
    $hint.textContent = d ? `Release to send to ${d.name}` : hintText();
  },
});
window.__lkweb = web; // used by the end-to-end test
const BOOPS = ["Hi there!", "Holding on tight", "All paws on deck", "Keeping you linked", "Boop!"];

// Sign-in backdrop: a slowly turning web with the otter at its heart.
const $backdrop = document.createElement("div");
$backdrop.className = "backdrop";
const demo = new NetWeb($backdrop, { demo: true });

const tabs = [["network", "Network"], ["drop", "Drop"], ["settings", "Settings"]];
$nav.querySelector(".cap").insertAdjacentHTML("beforeend", tabs.map(([id, label]) =>
  `<button data-act="tab" data-tab="${id}">${icon(id)}<span>${label}</span><span class="badge" data-badge="${id}" hidden></span></button>`).join(""));

function hintText() {
  const s = ui.state;
  if (!s || s.state !== "Running") return "";
  if (ui.tab === "drop") return s.devices.some((d) => d.canDrop && d.online) ? "Tap a device to pick it, or drag files onto it" : "";
  return s.devices.length ? "Tap a device for details · Drag files onto a device to send" : "";
}

// ---- views ------------------------------------------------------------------------------

function viewSignIn(s) {
  if (s.authUrl) return `
    <div class="center">
      ${otter("float", "Linkotter otter holding a link")}
      <div><span class="eyebrow">Almost there</span><h1>Finish signing in</h1>
      <p>Open the sign-in page to add this device to your network.</p></div>
      <button class="btn btn--hero" data-act="open-auth">Open Sign-In Page</button>
      <button class="btn btn--secondary" data-act="copy" data-text="${esc(s.authUrl)}">Copy Link</button>
      <button class="btn btn--sm" data-act="logout">Start over</button>
    </div>`;
  return `
    <div class="signin">
      <div><span class="eyebrow">Private network</span><h1>Reach every device, from anywhere.</h1>
      <p>Otters hold hands so they never drift apart. Sign in and this computer joins your network.</p></div>
      <form class="card stack" id="login">
        <label class="field">Server address
          <input type="text" name="server" value="${esc(ui.form.server || s.server)}" placeholder="link.example.com" autocomplete="off" spellcheck="false" required>
        </label>
        ${ui.showKey ? `<label class="field">Access key
          <input type="password" name="authKey" value="${esc(ui.form.authKey)}" autocomplete="off" spellcheck="false">
          <span class="hint">Your admin can create one. Leave blank to sign in through the browser.</span></label>` : ""}
        ${ui.error ? `<div class="error" role="alert">${esc(ui.error)}</div>` : ""}
        <button class="btn btn--hero btn--block" ${ui.busy ? "disabled" : ""}>${ui.busy ? `<span class="dots">Connecting</span>` : "Connect"}</button>
        ${ui.showKey ? "" : `<button type="button" class="btn btn--sm" data-act="show-key">I have an access key</button>`}
      </form>
    </div>`;
}

function leadNetwork(s) {
  const on = s.state === "Running", starting = s.state === "Starting";
  const reconnecting = starting && s.devices.length > 0;
  const online = s.devices.filter((d) => d.online).length;
  const title = reconnecting ? `<span class="dots">Reconnecting</span>` : starting ? `<span class="dots">Linking your devices</span>` : on
    ? (s.devices.length ? `${online} of ${s.devices.length} devices online` : "Just you, for now")
    : "Your devices are out of reach";
  return `<div class="lead">
    <div class="grow"><span class="eyebrow ${on || starting ? "" : "paused"}">${starting ? "Connecting" : on ? "Connected" : "Paused"}</span><h1>${title}</h1></div>
    <input type="checkbox" class="switch" role="switch" aria-label="Connection" data-act="toggle" ${on || starting ? "checked" : ""}>
  </div>`;
}

function devRow(d) {
  return `
    <div class="dev ${d.online ? "on" : "off"}">
      <div class="os">${icon(NetWeb.osIcon(d))}<span class="dot"></span></div>
      <div class="grow"><div class="nm">${esc(d.name)}</div>
        <div class="meta"><span>${esc(d.ip)}</span>${pathChip(d)}${!d.online && d.lastSeen ? `<span>seen ${ago(d.lastSeen)}</span>` : ""}</div></div>
      ${d.online ? `<button class="icon-btn" title="Test connection" aria-label="Test connection to ${esc(d.name)}" data-act="ping" data-id="${esc(d.id)}" data-ip="${esc(d.ip)}">${icon("pulse")}</button>` : ""}
      ${d.canDrop && d.online ? `<button class="icon-btn" title="Send files" aria-label="Send files to ${esc(d.name)}" data-act="send-to" data-id="${esc(d.id)}">${icon("send")}</button>` : ""}
      <button class="icon-btn" title="Details" aria-label="Details for ${esc(d.name)}" data-act="sheet" data-id="${esc(d.id)}">${icon("chevron")}</button>
    </div>`;
}

function viewNetwork(s) {
  const on = s.state === "Running" || s.state === "Starting";
  // Engine warnings, minus the ones the screen already says (paused / stopped).
  const health = (s.state === "Running" ? s.health || [] : []).filter((h) => !/is stopped/i.test(h)).map((h) => `<div class="card error" role="alert">${esc(h.replace(/Tailscale/g, "Linkotter"))}</div>`).join("");
  if (!on) return `${health}<div class="card empty stack"><h2>Taking a nap</h2>
    <p>Turn Linkotter on to reach your devices again. Your other internet traffic is never affected.</p>
    <button class="btn btn--hero" data-act="wake">Wake Up and Connect</button></div>`;
  if (s.state === "Running" && s.devices.length === 0) return `${health}<div class="card empty">${otter("float", "Otter holding a link")}
    <h2>Bring your other devices in</h2><p>Install Linkotter on your phone or another computer and sign in to the same server. It appears on the web the moment it joins.</p></div>`;
  const q = ui.query.trim().toLowerCase();
  const match = (d) => !q || d.name.toLowerCase().includes(q) || d.ip.includes(q);
  const groups = [["My devices", s.devices.filter((d) => d.mine && match(d))], ["Shared", s.devices.filter((d) => d.shared && match(d))], ["Team", s.devices.filter((d) => !d.mine && !d.shared && match(d))]];
  return `${health}
    <details class="all" ${ui.allOpen ? "open" : ""} id="all">
      <summary>${icon("chevron")} All devices <span class="count">${s.devices.length}</span></summary>
      ${s.devices.length > 6 ? `<div class="search"><input type="search" id="q" placeholder="Search devices" value="${esc(ui.query)}" aria-label="Search devices"></div>` : ""}
      <div class="list">${groups.map(([t, ds]) => ds.length ? `<div class="section-title" style="margin:10px 16px 2px">${t}</div>${ds.map(devRow).join("")}` : "").join("") ||
        `<div class="empty"><p>No device matches “${esc(ui.query)}”.</p></div>`}</div>
    </details>`;
}

function liveProgress(x) {
  const f = ui.xfer.out.find((o) => o.peer === x.to && o.name === x.name && !o.end);
  return f && f.size > 0 ? (f.done / f.size) * 100 : x.pct;
}

function viewDrop(s) {
  const targets = s.devices.filter((d) => d.canDrop);
  const running = s.state === "Running";
  const target = targets.find((d) => d.id === ui.target);
  let body;
  if (!running) body = `<div class="card empty">${otter("sleep", "Sleeping otter")}<p>Connect first to send and receive files.</p></div>`;
  else if (targets.length === 0) body = `<div class="card empty">${otter("float", "Otter holding a link")}<h2>No device to send to yet</h2><p>Sign in on another of your devices and it appears here.</p></div>`;
  else body = `
    <div class="card dropbar">
      <div class="hint">Send to</div>
      <div class="targets">${targets.map((d) => `<button class="target" data-act="target" data-id="${esc(d.id)}" aria-pressed="${ui.target === d.id}" ${d.online ? "" : 'disabled title="Offline"'}>${esc(d.name)}</button>`).join("")}</div>
      <button class="btn btn--hero" data-act="choose" ${target ? "" : "disabled"}>${icon("send")} ${target ? `Choose Files for ${esc(target.name)}` : "Pick a Device First"}</button>
      <input type="file" id="files" multiple hidden>
    </div>`;
  const live = ui.sending.length ? `<div class="list">${ui.sending.map((x) => {
    const pct = liveProgress(x);
    return `<div class="xfer ${x.error ? "fail" : x.done ? "done" : ""}"><div class="dir">${icon(x.done ? "check" : "up")}</div><div class="grow"><div class="nm">${esc(x.name)}</div>
      <div class="hint">${x.error ? esc(x.error) : x.done ? "Sent to " + esc(x.peer) : `Sending to ${esc(x.peer)} · ${Math.round(pct)}%`}</div>
      ${x.done || x.error ? "" : `<div class="bar"><i style="width:${pct}%"></i></div>`}</div>
      ${x.error ? `<button class="btn btn--sm btn--secondary" data-act="retry" data-id="${x.id}">Retry</button>` : ""}</div>`;
  }).join("")}</div>` : "";
  const incoming = ui.xfer.in.filter((f) => !f.end);
  const inc = incoming.length ? `<div class="list">${incoming.map((f) => {
    const pct = f.size > 0 ? (f.done / f.size) * 100 : 0;
    return `<div class="xfer"><div class="dir">${icon("down")}</div><div class="grow"><div class="nm">${esc(f.name)}</div>
      <div class="hint">Receiving · ${Math.round(pct)}%</div><div class="bar"><i style="width:${pct}%"></i></div></div></div>`;
  }).join("")}</div>` : "";
  return `${body}${inc}${live}
    <div class="row"><div class="section-title grow">History</div>
      <button class="btn btn--sm btn--secondary" data-act="reveal" data-path="${esc(s.downloadDir)}">${icon("folder")} Open Folder</button></div>
    ${ui.history.length === 0 ? `<div class="card empty"><p>Files you send and receive are listed here. Received files are saved to ${esc(s.downloadDir)}.</p></div>` : `
    <div class="list">${ui.history.map((t) => `
      <div class="xfer ${t.failed ? "fail" : ""}"><div class="dir">${icon(t.dir === "in" ? "down" : "up")}</div>
        <div class="grow"><div class="nm">${esc(t.name)}</div>
        <div class="hint">${t.failed ? esc(t.failed) : `${t.dir === "in" ? "Received" : "Sent" + (t.peer ? " to " + esc(t.peer) : "")} · ${size(t.size)} · ${ago(t.time)}`}</div></div>
        ${t.path ? `<button class="icon-btn" title="Show in folder" aria-label="Show ${esc(t.name)} in folder" data-act="reveal" data-path="${esc(t.path)}">${icon("folder")}</button>` : ""}
      </div>`).join("")}</div>`}`;
}

function viewSettings(s) {
  const toggle = (key, on, title, sub) => `<label class="setting"><span class="grow"><b>${title}</b><small>${sub}</small></span>
    <input type="checkbox" class="switch" role="switch" data-act="pref" data-key="${key}" ${on ? "checked" : ""}></label>`;
  const exits = s.devices.filter((d) => d.exitOption);
  return `
    <div class="list settings">
      ${s.autostart != null ? toggle("autostart", s.autostart, "Start when I sign in to this computer", "Linkotter opens quietly in the tray.") : ""}
      ${toggle("background", s.background, "Stay connected in the background", "Keeps this device reachable when the window is closed.")}
      ${toggle("useDns", s.useDns, "Use device names", "Reach devices by name. Other websites and apps keep using your normal DNS.")}
      ${toggle("acceptRoutes", s.acceptRoutes, "Reach office networks", "Use office LANs shared by a Linkotter device. Off by default.")}
      <label class="setting"><span class="grow"><b>Send all internet traffic through</b><small>Off by default, so your normal connection is untouched.</small></span>
        <select data-act="exit" style="max-width:170px" aria-label="Send all internet traffic through">
          <option value="">Nothing (normal)</option>
          ${exits.map((d) => `<option value="${esc(d.id)}" ${s.exitNode === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select></label>
    </div>
    <div class="section-title">Account</div>
    <div class="list">
      <div class="setting"><span class="grow"><b>${esc(s.user || "Signed in")}</b><small>${esc(s.server)}</small></span>
        <button class="btn btn--sm btn--danger" data-act="logout">Sign Out</button></div>
    </div>
    <p class="hint" style="text-align:center">Linkotter ${esc(s.version)}${s.engineVersion ? " · engine " + esc(s.engineVersion.split("-")[0]) : ""}</p>`;
}

function viewSheet(s) {
  const isSelf = ui.sheet === SELF;
  const d = isSelf ? s.self : s.devices.find((x) => x.id === ui.sheet);
  if (!d) return null;
  const ping = ui.pings[d.id];
  const fact = (k, v, copy) => `<dt>${k}</dt><dd title="${esc(v)}">${esc(v)}</dd>${copy ? `<button class="icon-btn" aria-label="Copy ${k.toLowerCase()}" data-act="copy" data-text="${esc(v)}">${icon("copy")}</button>` : "<span></span>"}`;
  return `<div class="grip"></div>
    <div class="sheet-head">
      <div class="os">${isSelf ? `<img src="otter.svg" alt="">` : icon(NetWeb.osIcon(d))}</div>
      <div class="grow"><h2>${esc(d.name)}</h2><div class="hint">${isSelf ? "This device" : esc([d.os, d.shared ? "shared" : d.mine ? "yours" : "teammate"].filter(Boolean).join(" · "))}</div></div>
      <button class="icon-btn" aria-label="Close" data-act="close-sheet">${icon("close")}</button>
    </div>
    <dl class="facts">
      ${fact("Address", d.ip, true)}
      ${d.dnsName ? fact("Name", d.dnsName, true) : ""}
      ${isSelf ? "" : `<dt>Connection</dt><dd>${pathChip(d)}</dd><span></span>`}
      ${ping ? `<dt>Last test</dt><dd>${esc(ping)}</dd><span></span>` : ""}
      ${!isSelf && !d.online && d.lastSeen ? fact("Last seen", ago(d.lastSeen)) : ""}
    </dl>
    ${isSelf ? "" : `<div class="actions">
      ${d.canDrop && d.online ? `<button class="btn btn--primary" data-act="send-to" data-id="${esc(d.id)}">${icon("send")} Send Files</button>` : ""}
      ${d.online ? `<button class="btn btn--secondary" data-act="ping" data-id="${esc(d.id)}" data-ip="${esc(d.ip)}">${icon("pulse")} Test Connection</button>` : ""}
    </div>`}`;
}

function openSheet(id) {
  ui.sheet = id;
  render();
  requestAnimationFrame(() => { $sheet.classList.add("open"); $sheet.querySelector(".panel button, .panel [tabindex]")?.focus({ preventScroll: true }); });
}
function closeSheet() {
  $sheet.classList.remove("open");
  const id = ui.sheet;
  ui.sheet = null;
  setTimeout(() => { if (!ui.sheet) $sheet.querySelector(".panel").innerHTML = ""; }, 350);
  document.querySelector(`[data-node="${CSS.escape(id || "")}"]`)?.focus({ preventScroll: true });
}

// ---- render ------------------------------------------------------------------------------

function render() {
  const s = ui.state;
  let screen = "loading";
  if (s && !s.engineOk) screen = "down";
  else if (s && s.state === "NeedsMachineAuth") screen = "approval";
  else if (s && (s.state === "NeedsLogin" || s.state === "NoState" || (s.authUrl && s.state !== "Running"))) screen = "signin";
  else if (s) screen = "main";
  const main = screen === "main";
  const cameFromSignIn = main && ui.lastScreen === "signin";
  ui.lastScreen = screen;

  // Keep focus and caret where the person is typing.
  const act = document.activeElement;
  const keep = act && $view.contains(act) && (act.id || act.name) ? { sel: act.id ? "#" + act.id : `[name=${act.name}]`, pos: act.selectionStart } : null;

  document.body.className = "tab-" + (main ? ui.tab : screen);
  const pill = document.getElementById("netpill");
  pill.hidden = !main || !s.network;
  if (main) { pill.className = "netpill" + (s.state === "Running" ? " on" : ""); pill.innerHTML = `<i></i>${esc(s.network || "")}`; pill.title = s.network || ""; }

  if (screen === "signin" && !s.authUrl) {
    if (!$backdrop.isConnected) { $lead.before($backdrop); demo.kick(); setTimeout(() => demo.otter.say("Let's link up!", 2600), 700); }
  }
  else $backdrop.remove();

  const showStage = main && ui.tab !== "settings";
  $stage.hidden = !showStage;
  if (main) {
    // "Starting" also covers brief reconnects; keep the web in place and just show the ripple.
    web.setData({ on: s.state === "Running" || (s.state === "Starting" && s.devices.length > 0), starting: s.state === "Starting", self: s.self, devices: s.devices });
    web.setMode(ui.tab === "drop" ? "target" : "normal", ui.tab === "drop" ? ui.target : ui.sheet);
    web.setTransfers(ui.xfer);
    $hint.textContent = hintText();
    if (showStage) web.kick();
    if (cameFromSignIn) web.welcome("Welcome aboard!");
  }

  if (!s) { $lead.innerHTML = ""; $view.innerHTML = `<div class="center"><p class="dots">Starting</p></div>`; }
  else if (screen === "down") { $lead.innerHTML = ""; $view.innerHTML = `<div class="center">${otter("sleep", "Sleeping otter")}<div><span class="eyebrow">Not running</span><h1>Linkotter service is stopped</h1><p>${esc(s.engineError)} Restart the computer, or reinstall Linkotter if this keeps happening.</p></div><button class="btn btn--primary" data-act="refresh">Try Again</button></div>`; }
  else if (screen === "approval") { $lead.innerHTML = ""; $view.innerHTML = `<div class="center">${otter("float", "Otter waiting")}<div><span class="eyebrow">One more step</span><h1>Waiting for approval</h1><p>An admin needs to approve this device. This page updates by itself.</p></div><button class="btn btn--secondary" data-act="logout">Sign Out</button></div>`; }
  else if (screen === "signin") { $lead.innerHTML = ""; $view.innerHTML = viewSignIn(s); }
  else if (ui.tab === "drop") { $lead.innerHTML = `<div class="lead"><div class="grow"><span class="eyebrow">Drop</span><h1>Send files across your web</h1></div></div>`; $view.innerHTML = viewDrop(s); }
  else if (ui.tab === "settings") { $lead.innerHTML = `<div class="lead"><div class="grow"><span class="eyebrow">Settings</span><h1>This device</h1></div></div>`; $view.innerHTML = viewSettings(s); }
  else { $lead.innerHTML = leadNetwork(s); $view.innerHTML = viewNetwork(s); }

  // Navigation capsule with a sliding highlight.
  $nav.hidden = !main;
  if (main) {
    for (const b of $nav.querySelectorAll("button")) {
      const cur = b.dataset.tab === ui.tab;
      cur ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current");
    }
    const badge = $nav.querySelector('[data-badge="drop"]');
    badge.hidden = !ui.unseen; badge.textContent = ui.unseen;
    requestAnimationFrame(() => {
      const cur = $nav.querySelector("[aria-current=page]"), sl = $nav.querySelector(".slider");
      if (cur) { sl.style.left = cur.offsetLeft + "px"; sl.style.width = cur.offsetWidth + "px"; }
    });
  }

  // Sheet.
  if (ui.sheet && main) {
    const html = viewSheet(s);
    if (html == null) closeSheet();
    else { const p = $sheet.querySelector(".panel"); p.innerHTML = html; p.setAttribute("aria-label", "Device details"); }
  } else if ($sheet.classList.contains("open")) closeSheet();

  if (keep) { const el = $view.querySelector(keep.sel); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (_) {} } }
}

// ---- data ----------------------------------------------------------------------------------

let refreshing = false, again = false;
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try { ui.state = await api("/api/state"); if (ui.state.transfers) ui.xfer = ui.state.transfers; }
  catch (e) { ui.state = { engineOk: false, engineError: e.message, devices: [], state: "NoState", version: "" }; }
  if (ui.target && !ui.state.devices.some((d) => d.id === ui.target && d.canDrop)) ui.target = "";
  refreshing = false; render();
  if (again) { again = false; refresh(); }
}
async function loadHistory() { try { ui.history = await api("/api/drop/history"); render(); } catch (_) {} }

let xferRender = 0;
function listen() {
  const es = new EventSource("/api/events?t=" + encodeURIComponent(token));
  es.onmessage = (e) => {
    if (e.data[0] === "{") {
      const m = JSON.parse(e.data);
      if (m.t === "xfer") {
        ui.xfer = { in: m.in || [], out: m.out || [] };
        web.setTransfers(ui.xfer);
        if (ui.tab === "drop" && !xferRender) xferRender = setTimeout(() => { xferRender = 0; render(); }, 150);
      }
      return;
    }
    if (e.data === "drop") { if (ui.tab !== "drop") ui.unseen++; loadHistory(); }
    refresh();
  };
}

// One upload attempt; transient failures (path still settling, device waking up) are retried
// a few times before the row is marked failed.
let sendSeq = 0;
function upload(x) {
  x.error = ""; x.done = false; x.pct = 0; x.tries = (x.tries || 0) + 1;
  const fail = (msg) => {
    if (x.tries < 3) { setTimeout(() => upload(x), 1500 * x.tries); return; }
    x.error = msg; web.burst(x.to, false); render();
  };
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/drop/send?to=${encodeURIComponent(x.to)}&name=${encodeURIComponent(x.name)}&peer=${encodeURIComponent(x.peer)}`);
  xhr.setRequestHeader("X-Linkotter-Token", token);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { x.pct = (e.loaded / e.total) * 100; if (ui.tab === "drop") render(); } };
  xhr.onload = () => {
    if (xhr.status === 200) { x.done = true; web.burst(x.to, true); render(); return; }
    let msg = "Could not send."; try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
    fail(msg);
  };
  xhr.onerror = () => fail("Could not send.");
  xhr.send(x.file);
  render();
}

function sendFiles(files) {
  const peer = ui.state && ui.state.devices.find((d) => d.id === ui.target);
  if (!peer) { toast("Pick a device first"); return; }
  if (!peer.canDrop || !peer.online) { toast(`${peer.name} cannot receive files right now`); return; }
  if (!files.length) return;
  // Optimistic progress on the web until the engine reports real bytes.
  for (const f of files) {
    const x = { id: ++sendSeq, file: f, name: f.name, to: peer.id, peer: peer.name, pct: 0 };
    ui.sending.unshift(x);
    upload(x);
  }
  web.react("send", `Sending to ${peer.name}`);
  if (ui.tab !== "drop") toast(`Sending ${files.length === 1 ? files[0].name : files.length + " files"} to ${peer.name}`);
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message); }
  refresh();
}

async function ping(id, ip) {
  const back = web.ping(id);
  try {
    const p = await api("/api/ping", { id, ip });
    const msg = `${p.kind === "direct" ? "Direct" : p.kind === "peer-relay" ? "Office relay" : "Relay " + (p.via || "")} · ${ms(p.latencyMs)}`;
    ui.pings[id] = msg; back(true, ms(p.latencyMs)); toast(msg);
  } catch (e) { back(false); toast(e.message); }
  refresh();
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]"); if (!el || el.tagName === "SELECT" || el.type === "checkbox") return;
  const a = el.dataset.act;
  if (a === "tab") { ui.tab = el.dataset.tab; if (ui.tab === "drop") { ui.unseen = 0; loadHistory(); } if (ui.sheet) closeSheet(); render(); window.scrollTo({ top: 0 }); }
  else if (a === "copy") navigator.clipboard.writeText(el.dataset.text).then(() => { toast("Copied"); web.react("wink", "Copied!"); }, () => toast(el.dataset.text));
  else if (a === "show-key") { ui.showKey = true; render(); }
  else if (a === "refresh") refresh();
  else if (a === "logout") { if (ui.sheet) closeSheet(); act(() => api("/api/logout", {})); }
  else if (a === "open-auth") act(() => api("/api/open-auth", {}));
  else if (a === "target") { ui.target = el.dataset.id; render(); }
  else if (a === "send-to") { ui.target = el.dataset.id; ui.tab = "drop"; if (ui.sheet) closeSheet(); loadHistory(); render(); }
  else if (a === "sheet") openSheet(el.dataset.id);
  else if (a === "wake") act(() => api("/api/connect", {}));
  else if (a === "close-sheet") closeSheet();
  else if (a === "choose") document.getElementById("files").click();
  else if (a === "retry") { const x = ui.sending.find((y) => y.id === +el.dataset.id); if (x) { x.tries = 0; upload(x); } }
  else if (a === "reveal") act(() => api("/api/drop/reveal", { path: el.dataset.path }));
  else if (a === "ping") { el.disabled = true; ping(el.dataset.id, el.dataset.ip); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.sheet) closeSheet(); });
document.addEventListener("toggle", (e) => { if (e.target.id === "all") ui.allOpen = e.target.open; }, true);
document.addEventListener("change", (e) => {
  const el = e.target, a = el.dataset.act;
  if (a === "toggle") act(() => api(el.checked ? "/api/connect" : "/api/disconnect", {}));
  else if (a === "pref") act(() => api("/api/prefs", { [el.dataset.key]: el.checked }));
  else if (a === "exit") act(() => api("/api/prefs", { exitNode: el.value }), el.value ? "All traffic now goes through that device" : "Back to your normal connection");
  else if (el.id === "files") { sendFiles([...el.files]); el.value = ""; }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "q") { ui.query = e.target.value; render(); }
  else if (e.target.name === "server") ui.form.server = e.target.value;
  else if (e.target.name === "authKey") ui.form.authKey = e.target.value;
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "login") return;
  e.preventDefault();
  const f = new FormData(e.target);
  ui.busy = true; ui.error = ""; render();
  demo.react("excited", "Paddling over…");
  try { await api("/api/login", { server: f.get("server"), authKey: f.get("authKey") || "" }); ui.form.authKey = ""; }
  catch (err) { ui.error = err.message; demo.react("sad", "Hmm, that didn't work"); }
  ui.busy = false; refresh();
});
// Files dropped outside the web go to the picked device; never let a drop navigate the window away.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length && ui.state && ui.state.state === "Running") {
    if (ui.target) sendFiles([...e.dataTransfer.files]); else toast("Drop the files onto a device");
  }
});

render(); refresh(); loadHistory(); listen();
setInterval(refresh, 5000);
