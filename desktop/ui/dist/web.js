"use strict";
// NetWeb: the live network web. This device sits at the centre; every other device is a node on
// the web, joined by a thread that shows how traffic actually flows (direct, through an office
// relay, or through a regional relay). Real traffic moves along the threads as packets, file
// transfers stream along them as chunks, and connecting spins the web out from the centre.
//
// Plain SVG driven by one requestAnimationFrame loop that stops itself when nothing moves.

(function () {
  const NS = "http://www.w3.org/2000/svg";
  const VB = { w: 400, h: 392, cx: 200, cy: 186 };
  const R_ON = 128, R2_IN = 94, R2_OUT = 150, R_OFF = 170, R_RELAY = 64;
  const MAX_ONLINE = 18, MAX_OFFLINE = 10;
  const SELF = "__self";
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");

  const ICONS = {
    laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    mark: '<rect x="2.5" y="9" width="11" height="6" rx="3" transform="rotate(-45 8 12)"/><rect x="10.5" y="9" width="11" height="6" rx="3" transform="rotate(-45 16 12)"/>',
    check: '<path d="m6 12.5 4 4 8-9"/>',
  };
  window.LK_ICONS = ICONS;
  const osIcon = (d) => d.shared ? "server" : /android|ios/i.test(d.os || "") ? "phone" : /linux/i.test(d.os || "") && !d.mine ? "server" : "laptop";

  let uid = 0;
  function mk(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const fmtMs = (ms) => (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + " ms";

  function pathLabel(d) {
    if (!d.online) return "Offline";
    const p = d.path || {}, ms = p.latencyMs != null ? " · " + fmtMs(p.latencyMs) : "";
    if (p.kind === "direct") return "Direct" + ms;
    if (p.kind === "peer-relay") return "Office relay" + ms;
    if (p.kind === "relay") return (p.via ? "via " + p.via : "Relay") + ms;
    return "Ready";
  }

  // Point at fraction f along a polyline.
  function along(pts, f) {
    let total = 0;
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      segs.push(l); total += l;
    }
    let d = Math.max(0, Math.min(1, f)) * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) {
        const t = segs[i] ? d / segs[i] : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
      }
      d -= segs[i];
    }
    return pts[pts.length - 1];
  }

  // The otter at the heart of the web. Its face is built from parts so it can react: eyes that
  // follow what you point at, blinks, moods for what the app is doing, and a speech bubble.
  const OTTER_FACE = (u) => `
    <defs><clipPath id="oc-${u}"><ellipse cx="50" cy="55" rx="34" ry="28"/></clipPath></defs>
    <g class="o-ears"><circle cx="19" cy="45" r="7.5" class="fur"/><circle cx="81" cy="45" r="7.5" class="fur"/>
      <circle cx="19" cy="45" r="3.6" class="fur-d"/><circle cx="81" cy="45" r="3.6" class="fur-d"/></g>
    <ellipse cx="50" cy="55" rx="34" ry="28" class="fur"/>
    <ellipse cx="50" cy="74" rx="30" ry="15" class="cream" clip-path="url(#oc-${u})"/>
    <circle cx="42.5" cy="66" r="9.5" class="pad"/><circle cx="57.5" cy="66" r="9.5" class="pad"/>
    <path class="whisk" d="M34 63 13 58M34 67 12 68M66 63 87 58M66 67 88 68"/>
    <ellipse cx="29" cy="60" rx="5" ry="3" class="o-blush"/><ellipse cx="71" cy="60" rx="5" ry="3" class="o-blush"/>
    <path class="ink-s b-sad" d="M31 43.5l9-3M69 43.5l-9-3"/>
    <path class="ink-s b-focus" d="M31 41l9 3M69 41l-9 3"/>
    ${[["el", 37], ["er", 63]].map(([c, x]) => `<g class="o-eye ${c}" transform="translate(${x} 50)">
      <g class="lid"><g class="open"><circle r="3.8" class="ink pupil"/><circle cx="1.2" cy="-1.2" r="1.2" class="hl"/></g></g>
      <path class="ink-s shut" d="M-4 -.5q4 3.2 8 0"/><path class="ink-s joy" d="M-4 1.2q4-4.2 8 0"/></g>`).join("")}
    <path d="M43 58.6c0-2.3 3.1-3.6 7-3.6s7 1.3 7 3.6c0 2.6-3.9 5-7 5s-7-2.4-7-5z" class="ink"/>
    <g class="o-mouth">
      <path class="ink-s m-smile" d="M50 63.5v2M45.6 67.2c1.6 1.6 3.2 1.4 4.4-.5 1.2 1.9 2.8 2.1 4.4.5"/>
      <ellipse class="ink m-open" cx="50" cy="68.4" rx="2.8" ry="3.3"/>
      <path class="ink-s m-sad" d="M50 63.5v1.5M45.5 69.3q4.5-3.4 9 0"/>
      <path class="ink-s m-flat" d="M50 63.5v2.5M46.5 67.6h7"/>
      <path class="ink m-grin" d="M50 63.5v1.5M44.2 66q5.8 7.6 11.6 0z"/>
    </g>
    <g class="freck"><circle cx="38" cy="65" r="1"/><circle cx="40" cy="69" r="1"/><circle cx="62" cy="65" r="1"/><circle cx="60" cy="69" r="1"/></g>`;

  class Otter {
    constructor(parent, layer, u) {
      this.root = mk("g", { class: "otter", "data-mood": "idle", transform: "translate(-29 -29) scale(0.58)" }, parent);
      const bob = mk("g", { class: "o-bob" }, this.root);
      this.head = mk("g", { class: "o-head" }, bob);
      this.head.innerHTML = OTTER_FACE(u);
      const z = mk("g", { class: "o-zzz" }, this.root);
      [[78, 30, 11], [87, 18, 14], [97, 4, 17]].forEach(([x, y, fs], i) => {
        const t = mk("text", { x, y, "font-size": fs, style: `animation-delay:${i * 0.5}s` }, z);
        t.textContent = "z";
      });
      this.pupils = [...this.head.querySelectorAll(".open")];
      this.bub = mk("g", { class: "bubble", transform: `translate(${VB.cx} ${VB.cy - 47})` }, layer);
      const bin = mk("g", { class: "b-in" }, this.bub);
      this.bubRect = mk("rect", { rx: 11, height: 23, y: -26 }, bin);
      mk("path", { d: "M-5 -3.5 L0 3 L5 -3.5z" }, bin);
      this.bubText = mk("text", { y: -10.5 }, bin);
      this.base = "idle"; this.flashMood = null;
      this.look = [0, 0]; this.cur = [0, 0];
      this._blink();
    }
    get mood() { return this.flashMood || this.base; }
    setBase(m) { if (this.base !== m) { this.base = m; this._apply(); } }
    flash(m, ms, text) {
      this.flashMood = m;
      clearTimeout(this.ft);
      this.ft = setTimeout(() => { this.flashMood = null; this._apply(); }, ms);
      this._apply();
      if (text) this.say(text, Math.max(ms, 1600));
    }
    _apply() {
      const m = this.mood;
      if (this.root.getAttribute("data-mood") !== m) {
        // Restart one-shot animations (hops) when the mood is re-entered.
        this.root.setAttribute("data-mood", "");
        void this.root.getBoundingClientRect();
        this.root.setAttribute("data-mood", m);
      }
    }
    say(text, ms = 1800) {
      this.bubText.textContent = text;
      let w = 0;
      try { w = this.bubText.getComputedTextLength(); } catch (_) {}
      w = Math.min(240, (w || text.length * 6.4) + 24);
      this.bubRect.setAttribute("x", (-w / 2).toFixed(1));
      this.bubRect.setAttribute("width", w.toFixed(1));
      this.bub.classList.add("show");
      clearTimeout(this.bt);
      this.bt = setTimeout(() => this.bub.classList.remove("show"), ms);
    }
    step(dt) {
      const k = reduceMQ.matches ? 1 : 1 - Math.exp(-dt * 7);
      this.cur[0] += (this.look[0] - this.cur[0]) * k;
      this.cur[1] += (this.look[1] - this.cur[1]) * k;
      const [x, y] = this.cur;
      const pt = `translate(${(x * 2.3).toFixed(2)} ${(y * 2).toFixed(2)})`;
      for (const p of this.pupils) p.setAttribute("transform", pt);
      this.head.setAttribute("transform", `translate(${(x * 1.6).toFixed(2)} ${(y * 1.2).toFixed(2)})`);
      return Math.abs(this.look[0] - x) > 0.01 || Math.abs(this.look[1] - y) > 0.01;
    }
    _blink() {
      setTimeout(() => {
        const m = this.mood;
        if (document.visibilityState === "visible" && !reduceMQ.matches && !["sleep", "happy", "caught", "sleepy", "wink"].includes(m)) {
          this.root.classList.add("blink");
          setTimeout(() => this.root.classList.remove("blink"), 140);
        }
        this._blink();
      }, 2400 + Math.random() * 3600);
    }
  }

  class NetWeb {
    constructor(host, opts = {}) {
      this.opts = opts;
      this.demo = !!opts.demo;
      this.id = ++uid;
      const svg = (this.svg = mk("svg", { viewBox: `0 0 ${VB.w} ${VB.h}`, class: "web-svg" + (this.demo ? " demo" : "") }));
      if (this.demo) svg.setAttribute("aria-hidden", "true");
      else { svg.setAttribute("role", "group"); svg.setAttribute("aria-label", "Network map"); }
      const defs = mk("defs", {}, svg);
      const g1 = mk("linearGradient", { id: `lk-grad-${this.id}`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      mk("stop", { offset: 0, "stop-color": "#6C68FD" }, g1);
      mk("stop", { offset: 1, "stop-color": "#0D54FE" }, g1);
      const g2 = mk("radialGradient", { id: `lk-glow-${this.id}` }, defs);
      mk("stop", { offset: 0, class: "glow-in" }, g2);
      mk("stop", { offset: 1, class: "glow-out" }, g2);

      this.L = {};
      for (const name of ["bg", "threads", "edges", "parts", "nodes", "fx", "ui"]) this.L[name] = mk("g", { class: "l-" + name }, svg);
      mk("circle", { cx: VB.cx, cy: VB.cy, r: R_OFF + 14, fill: `url(#lk-glow-${this.id})`, class: "glow" }, this.L.bg);
      for (const r of [R_RELAY, R_ON, R_OFF]) mk("circle", { cx: VB.cx, cy: VB.cy, r, class: "ring" }, this.L.bg);
      this.threadOuter = mk("path", { class: "thread" }, this.L.threads);
      this.threadInner = mk("path", { class: "thread inner" }, this.L.threads);

      this.nodes = new Map();
      this.edges = new Map();
      this.parts = [];
      this.fx = [];
      this.on = false;
      this.starting = false;
      this.mode = "normal";
      this.selected = null;
      this.hover = null;
      this.samples = new Map(); // device id -> {t, rx, tx}
      this.rates = new Map();   // device id -> {rate, inShare}
      this.out = new Map();     // transfer key -> {peer, size, done, end}
      this.inActive = [];
      this.inSeen = false;
      this.lastBurst = new Map();
      this.nextRipple = 0;
      this.spin = 0;

      const self = this._node(SELF, "self");
      self.x = self.tx = VB.cx; self.y = self.ty = VB.cy; self.s = self.ts = 1; self.o = self.to = 1;

      if (this.demo) this._demoInit();
      else this._bindDrag();
      host.appendChild(svg);
      document.addEventListener("visibilitychange", () => this.kick());
      reduceMQ.addEventListener?.("change", () => this.kick());
      this.raf = 0;
      this.kick();
    }

    get reduced() { return reduceMQ.matches; }

    // ---- nodes ------------------------------------------------------------------------

    _node(id, kind) {
      const g = mk("g", { class: `node ${kind}`, "data-node": id }, this.L.nodes);
      const vis = mk("g", { class: "vis" }, g);
      const n = { id, kind, g, vis, x: VB.cx, y: VB.cy, tx: VB.cx, ty: VB.cy, s: 0.3, ts: 1, o: 0, to: 1, data: null, removing: false, prog: 0, tprog: 0 };
      if (kind === "self") {
        n.r = 30;
        mk("circle", { r: 44, class: "halo" }, vis);
        mk("circle", { r: 40, class: "orbit" }, vis);
        n.progEl = mk("circle", { r: 37, class: "prog" }, vis);
        mk("rect", { x: -29, y: -29, width: 58, height: 58, rx: 15, class: "body", style: `fill:url(#lk-grad-${this.id});stroke:none` }, vis);
        this.otter = new Otter(vis, this.L.ui, this.id);
        n.name = mk("text", { y: 48, class: "name" }, vis);
        n.sub = mk("text", { y: 61, class: "sub" }, vis);
      } else if (kind === "relay") {
        n.r = 14;
        const pts = [];
        for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; pts.push((14 * Math.cos(a)).toFixed(1) + "," + (14 * Math.sin(a)).toFixed(1)); }
        mk("polygon", { points: pts.join(" "), class: "body" }, vis);
        n.code = mk("text", { y: 3.5, class: "code" }, vis);
        n.name = mk("text", { y: 27, class: "sub" }, vis);
      } else {
        n.r = 21;
        mk("circle", { r: 31, class: "halo" }, vis);
        n.progEl = mk("circle", { r: 27, class: "prog" }, vis);
        mk("circle", { r: 21, class: "body" }, vis);
        n.ico = mk("g", { class: "ico", transform: "translate(-10 -10) scale(0.8333)" }, vis);
        mk("circle", { cx: 15, cy: -15, r: 4.5, class: "dot" }, vis);
        n.okMark = mk("g", { class: "okmark", transform: "translate(-10 -10) scale(0.8333)" }, vis);
        n.okMark.innerHTML = ICONS.check;
        n.name = mk("text", { y: 37, class: "name" }, vis);
        n.sub = mk("text", { y: 50, class: "sub" }, vis);
      }
      if (n.progEl) {
        n.progLen = 2 * Math.PI * +n.progEl.getAttribute("r");
        n.progEl.setAttribute("stroke-dasharray", `${n.progLen} ${n.progLen}`);
        n.progEl.setAttribute("stroke-dashoffset", n.progLen);
      }
      if (!this.demo && kind !== "relay") {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
        const go = () => this.opts.onSelect && this.opts.onSelect(id);
        g.addEventListener("click", go);
        g.addEventListener("pointerenter", () => { this.pointer = id; this.kick(); });
        g.addEventListener("pointerleave", () => { if (this.pointer === id) this.pointer = null; this.kick(); });
        g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
      }
      this.nodes.set(id, n);
      return n;
    }

    _labelPeer(n, d, compact) {
      const name = clip(d.name || "device", compact ? 10 : 14);
      if (n.name.textContent !== name) n.name.textContent = name;
      const sub = compact || !d.online ? (d.online ? "" : compact ? "" : "Offline") : pathLabel(d);
      if (n.sub.textContent !== sub) n.sub.textContent = sub;
      const ico = osIcon(d);
      if (n.icoName !== ico) { n.ico.innerHTML = ICONS[ico]; n.icoName = ico; }
      const label = `${d.name}, ${d.online ? pathLabel(d) : "offline"}`;
      n.g.setAttribute("aria-label", label);
      n.g.classList.toggle("on", !!d.online);
      n.g.classList.toggle("off", !d.online);
      n.g.classList.toggle("small", !d.online);
      n.g.classList.toggle("shared", !!d.shared);
      n.g.classList.toggle("nodrop", this.mode === "target" && !(d.canDrop && d.online));
      n.g.classList.toggle("sel", this.selected === d.id);
    }

    // ---- data -------------------------------------------------------------------------

    setData({ on, starting, self, devices }) {
      const wasOn = this.on;
      this.on = !!on;
      this.starting = !!starting;
      this.svg.classList.toggle("is-on", this.on);
      this.svg.classList.toggle("is-starting", this.starting);
      const me = this.nodes.get(SELF);
      if (self) {
        const nm = clip(self.name || "This device", 16);
        if (me.name.textContent !== nm) me.name.textContent = nm;
        const sub = this.on ? self.ip || "" : this.starting ? "Connecting…" : "Paused";
        if (me.sub.textContent !== sub) me.sub.textContent = sub;
        me.data = self;
        me.g.setAttribute("aria-label", `This device, ${self.name || ""}`);
      } else {
        const sub = this.starting ? "Connecting…" : "Paused";
        if (me.sub.textContent !== sub) me.sub.textContent = sub;
      }

      // Traffic rates from the engine's byte counters.
      const now = performance.now();
      for (const d of devices || []) {
        const prev = this.samples.get(d.id);
        if (prev && now - prev.t > 500) {
          const din = Math.max(0, d.rx - prev.rx), dout = Math.max(0, d.tx - prev.tx), secs = (now - prev.t) / 1000;
          this.rates.set(d.id, { rate: (din + dout) / secs, inShare: din + dout ? din / (din + dout) : 0.5 });
        }
        if (!prev || now - prev.t > 500) this.samples.set(d.id, { t: now, rx: d.rx, tx: d.tx });
      }

      // The otter reacts to what changed since the last update.
      const o = this.otter;
      const onlineNow = new Map((devices || []).filter((d) => d.online).map((d) => [d.id, d]));
      if (this.inited && o) {
        if (this.on && !wasOn) { o.flash("happy", 2200, this.pendingHello || "All linked!"); this.pendingHello = null; }
        else if (!this.on && wasOn && !this.starting) o.flash("sleepy", 1500, "Nap time");
        else if (this.on && wasOn) {
          const joined = [...onlineNow.values()].filter((d) => !this.prevOnline.has(d.id));
          const left = [...this.prevOnline.values()].filter((d) => !onlineNow.has(d.id));
          if (joined.length) {
            o.flash("surprised", 1900, joined.length === 1 ? `Hi, ${clip(joined[0].name, 16)}!` : `${joined.length} devices joined`);
            this.glance = { id: joined[0].id, until: now + 2000 };
          } else if (left.length) {
            o.flash("sad", 1700, left.length === 1 ? `Bye, ${clip(left[0].name, 16)}` : `${left.length} devices left`);
            this.glance = { id: left[0].id, until: now + 1700 };
          }
        }
      }
      this.prevOnline = onlineNow;
      this.inited = true;

      const list = this.on ? devices || [] : [];
      const online = list.filter((d) => d.online).slice(0, MAX_ONLINE);
      const offline = list.filter((d) => !d.online).slice(0, MAX_OFFLINE);
      const compact = online.length > 8;
      this.svg.classList.toggle("compact", compact);
      const seen = new Set([SELF]);
      const placeAt = (d, r, a) => {
        let n = this.nodes.get(d.id);
        const fresh = !n || n.removing;
        if (!n) n = this._node(d.id, "peer");
        if (fresh && d.online) { n.x = VB.cx; n.y = VB.cy; n.s = 0.3; n.o = 0; }
        if (fresh && !d.online) { n.x = VB.cx + r * Math.cos(a); n.y = VB.cy + r * Math.sin(a); n.o = 0; }
        n.removing = false;
        n.tx = VB.cx + r * Math.cos(a);
        n.ty = VB.cy + r * Math.sin(a);
        n.a = a;
        n.ts = d.online ? 1 : 0.62;
        n.to = 1;
        n.data = d;
        this._labelPeer(n, d, compact);
        seen.add(d.id);
        return n;
      };

      const step = (2 * Math.PI) / Math.max(online.length, 1);
      online.forEach((d, i) => {
        const a = -Math.PI / 2 + i * step;
        const r = online.length > 10 ? (i % 2 ? R2_OUT : R2_IN) : R_ON;
        placeAt(d, r, a);
      });
      const stepOff = (2 * Math.PI) / Math.max(offline.length, 1);
      offline.forEach((d, i) => placeAt(d, R_OFF, -Math.PI / 2 + stepOff / 2 + i * stepOff));

      // Regional relays sit between this device and the devices they carry.
      const relays = new Map();
      for (const d of online) {
        if (d.path && d.path.kind === "relay") {
          const key = "relay:" + (d.path.via || "relay");
          if (!relays.has(key)) relays.set(key, { via: d.path.via || "Relay", angles: [] });
          relays.get(key).angles.push(this.nodes.get(d.id).a);
        }
      }
      for (const [key, r] of relays) {
        let n = this.nodes.get(key);
        if (!n || n.removing) {
          n = n || this._node(key, "relay");
          n.x = VB.cx; n.y = VB.cy; n.s = 0.3; n.o = 0; n.removing = false;
        }
        const sx = r.angles.reduce((s, a) => s + Math.cos(a), 0), sy = r.angles.reduce((s, a) => s + Math.sin(a), 0);
        const a = sx || sy ? Math.atan2(sy, sx) : -Math.PI / 2;
        n.tx = VB.cx + R_RELAY * Math.cos(a);
        n.ty = VB.cy + R_RELAY * Math.sin(a);
        n.ts = 1; n.to = 1;
        const code = r.via.split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();
        n.code.textContent = code;
        n.name.textContent = compact ? "" : clip(r.via + " relay", 18);
        n.g.setAttribute("aria-hidden", "true");
        seen.add(key);
      }

      // Threads (edges).
      let order = 0;
      const seenEdges = new Set();
      for (const d of online) {
        const kind = (d.path && d.path.kind) || "idle";
        let e = this.edges.get(d.id);
        if (!e) {
          e = { id: d.id, el: mk("path", { class: "edge" }, this.L.edges), draw: 0, tdraw: 1, delay: 0 };
          this.edges.set(d.id, e);
          if (!this.reduced) e.delay = now + (wasOn ? 0 : 90 * order++);
        }
        e.tdraw = 1;
        e.kind = kind;
        e.via = kind === "relay" ? "relay:" + (d.path.via || "relay") : null;
        e.el.setAttribute("class", `edge ${kind}`);
        seenEdges.add(d.id);
      }
      for (const [id, e] of this.edges) if (!seenEdges.has(id)) e.tdraw = 0;

      for (const [id, n] of this.nodes) {
        if (seen.has(id)) continue;
        n.removing = true;
        n.to = 0;
        n.ts = 0.3;
        if (n.kind !== "self") { n.tx = VB.cx; n.ty = VB.cy; }
      }

      if (this.on && !wasOn && !this.reduced) this._ripple(1);
      this.kick();
    }

    setMode(mode, selected) {
      this.mode = mode;
      this.selected = selected || null;
      this.svg.classList.toggle("mode-target", mode === "target");
      for (const n of this.nodes.values()) {
        if (n.kind !== "peer" || !n.data) continue;
        n.g.classList.toggle("nodrop", mode === "target" && !(n.data.canDrop && n.data.online));
        n.g.classList.toggle("sel", this.selected === n.id);
      }
    }

    // Live transfers from the engine: {out: [{id, peer, name, size, done, end}], in: [...]}.
    setTransfers(t) {
      for (const f of t.out || []) {
        const key = f.id || f.peer + "/" + f.name;
        const prev = this.out.get(key);
        if (prev && !prev.end && f.end) this.burst(f.peer, f.end === "ok");
        this.out.set(key, { peer: f.peer, size: f.size, done: f.done, end: f.end || "" });
      }
      const active = (t.in || []).filter((f) => !f.end);
      if (this.inActive.length && active.length < this.inActive.length) {
        const got = this.inActive.find((f) => !active.some((a) => a.name === f.name));
        this.burst(SELF, true);
        if (this.otter) this.otter.flash("caught", 2000, got ? `Got ${clip(got.name, 22)}!` : "Got it!");
      }
      this.inActive = active;
      this.kick();
    }

    // ---- effects ------------------------------------------------------------------------

    burst(id, ok) {
      const n = this.nodes.get(id);
      if (!n) return;
      const now = performance.now();
      if (now - (this.lastBurst.get(id) || 0) < 900) return;
      this.lastBurst.set(id, now);
      n.g.classList.remove("flash-ok", "flash-fail");
      void n.g.getBBox; // restart the CSS animation
      requestAnimationFrame(() => n.g.classList.add(ok ? "flash-ok" : "flash-fail"));
      setTimeout(() => n.g.classList.remove("flash-ok", "flash-fail"), 1400);
      const e = this.edges.get(id);
      if (e && !ok) { e.el.classList.add("fail"); setTimeout(() => e.el.classList.remove("fail"), 1400); }
      if (id !== SELF && this.otter && !this.demo) {
        const nm = n.data ? clip(n.data.name || "", 16) : "";
        if (ok) this.otter.flash("happy", 1800, "Delivered!");
        else this.otter.flash("sad", 2300, nm ? `Couldn't reach ${nm}` : "That didn't work");
        this.glance = { id, until: performance.now() + 1500 };
      }
      if (this.reduced) return;
      for (let i = 0; i < 2; i++) {
        const el = mk("circle", { class: "burst " + (ok ? "ok" : "fail"), r: n.r }, this.L.fx);
        this.fx.push({ el, node: id, t0: now + i * 160, dur: 750, r0: n.r, r1: n.r + 30 });
      }
      this.kick();
    }

    // Round trip of a connection test: a packet out, and one back when the answer arrives.
    ping(id) {
      const o = this.otter;
      o.flash("listening", 6000);
      this.glance = { id, until: performance.now() + 6000 };
      if (!this.reduced) this._emit(this._route(id), "pkt ping", 520);
      this.kick();
      return (ok, text) => {
        this.glance = { id, until: performance.now() + 1400 };
        if (ok) o.flash("happy", 1600, text || "Hello back!"); else o.flash("sad", 1800, "No answer");
        if (!this.reduced) this._emit(this._route(id).slice().reverse(), ok ? "pkt ping" : "pkt fail", 520);
        this.kick();
      };
    }

    // Greets on the next connect, or now if already connected.
    welcome(text) {
      if (this.on) this.react("hello", text);
      else this.pendingHello = text;
    }

    // Small reactions requested by the app.
    react(kind, text) {
      const o = this.otter;
      if (!o) return;
      const map = { wink: ["wink", 1200], send: ["focus", 1400], hello: ["happy", 2200], excited: ["excited", 2500], sad: ["sad", 2200], boop: ["happy", 1300] };
      const [m, ms] = map[kind] || ["happy", 1500];
      o.flash(m, ms, text);
      this.kick();
    }

    _ripple(strength) {
      const el = mk("circle", { class: "ripple", r: 30, cx: VB.cx, cy: VB.cy }, this.L.fx);
      this.fx.push({ el, center: true, t0: performance.now(), dur: 1500, r0: 30, r1: R_ON + 30, o0: 0.55 * strength });
    }

    _route(id) {
      const e = this.edges.get(id);
      return e && e.via && this.nodes.has(e.via) ? [SELF, e.via, id] : [SELF, id];
    }

    _emit(route, cls, dur) {
      const chunk = /chunk/.test(cls);
      const el = chunk
        ? mk("rect", { class: cls, width: 7, height: 7, rx: 2, x: -3.5, y: -3.5 }, this.L.parts)
        : mk("circle", { class: cls, r: 2.8 }, this.L.parts);
      this.parts.push({ el, route, t0: performance.now(), dur });
    }

    // ---- frame loop ---------------------------------------------------------------------

    kick() {
      if (this.raf || document.visibilityState !== "visible") return;
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this._frame(t));
    }

    _frame(t) {
      this.raf = 0;
      const dt = Math.min(0.05, Math.max(0, (t - this.last) / 1000));
      this.last = t;
      if (!this.svg.isConnected || this.svg.getBoundingClientRect().width === 0) return; // hidden; kick() resumes
      if (this._step(dt, t) && document.visibilityState === "visible") this.raf = requestAnimationFrame((x) => this._frame(x));
    }

    _pos(id) {
      if (id === "outer") return [VB.cx, 4];
      const n = this.nodes.get(id);
      return n ? [n.x, n.y] : null;
    }

    _step(dt, now) {
      const reduced = this.reduced;
      const k = reduced ? 1 : 1 - Math.exp(-dt * 8);
      let busy = false;

      if (this.demo) busy = this._demoStep(dt, now) || busy;

      // Nodes: ease toward their targets.
      for (const [id, n] of this.nodes) {
        n.x += (n.tx - n.x) * k; n.y += (n.ty - n.y) * k;
        n.s += (n.ts - n.s) * k; n.o += (n.to - n.o) * k;
        n.prog += (n.tprog - n.prog) * (reduced ? 1 : 1 - Math.exp(-dt * 6));
        if (Math.abs(n.tx - n.x) > 0.2 || Math.abs(n.ty - n.y) > 0.2 || Math.abs(n.ts - n.s) > 0.005 || Math.abs(n.to - n.o) > 0.01 || Math.abs(n.tprog - n.prog) > 0.002) busy = true;
        if (n.removing && n.o < 0.03) { n.g.remove(); this.nodes.delete(id); continue; }
        n.g.setAttribute("transform", `translate(${n.x.toFixed(2)} ${n.y.toFixed(2)}) scale(${n.s.toFixed(3)})`);
        n.g.setAttribute("opacity", n.o.toFixed(3));
        if (n.progEl) {
          n.progEl.setAttribute("stroke-dashoffset", (n.progLen * (1 - n.prog)).toFixed(2));
          n.progEl.classList.toggle("show", n.tprog > 0);
        }
      }

      // Threads.
      const me = this.nodes.get(SELF);
      for (const [id, e] of this.edges) {
        const n = this.nodes.get(id);
        if (now >= e.delay) e.draw += (e.tdraw - e.draw) * (reduced ? 1 : 1 - Math.exp(-dt * 5));
        if (Math.abs(e.tdraw - e.draw) > 0.004) busy = true;
        if (!n || (e.tdraw === 0 && e.draw < 0.02)) { e.el.remove(); this.edges.delete(id); continue; }
        const pts = [[me.x, me.y]];
        if (e.via && this.nodes.has(e.via)) { const r = this.nodes.get(e.via); pts.push([r.x, r.y]); }
        pts.push([n.x, n.y]);
        // Trim the ends so threads meet the node edges, not their centres.
        const trim = (a, b, by) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [a[0] + ((b[0] - a[0]) * by) / l, a[1] + ((b[1] - a[1]) * by) / l]; };
        pts[0] = trim(pts[0], pts[1], 30);
        pts[pts.length - 1] = trim(pts[pts.length - 1], pts[pts.length - 2], 22 * n.s);
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        e.el.setAttribute("d", "M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L"));
        if (e.draw < 0.995) {
          e.el.style.strokeDasharray = `${len.toFixed(1)} ${(len + 2).toFixed(1)}`;
          e.el.style.strokeDashoffset = (len * (1 - e.draw)).toFixed(1);
          e.drawing = true;
        } else if (e.drawing) {
          e.el.style.strokeDasharray = ""; e.el.style.strokeDashoffset = ""; e.drawing = false;
        }
      }

      // The web itself: threads joining neighbouring devices.
      const ring = [...this.nodes.values()].filter((n) => n.kind === "peer" && !n.removing && n.data && n.data.online && n.o > 0.05);
      if (ring.length >= 3) {
        ring.sort((a, b) => a.a - b.a);
        const poly = (f) => "M" + ring.map((n) => (VB.cx + (n.x - VB.cx) * f).toFixed(1) + " " + (VB.cy + (n.y - VB.cy) * f).toFixed(1)).join(" L") + " Z";
        this.threadOuter.setAttribute("d", poly(1));
        this.threadInner.setAttribute("d", poly(0.55));
      } else {
        this.threadOuter.setAttribute("d", "");
        this.threadInner.setAttribute("d", "");
      }

      // Transfers out: stream chunks along the thread and fill the progress ring.
      const perPeer = new Map();
      for (const f of this.out.values()) {
        if (f.end) continue;
        const p = perPeer.get(f.peer) || { size: 0, done: 0 };
        p.size += Math.max(f.size, 0); p.done += f.done;
        perPeer.set(f.peer, p);
      }
      for (const n of this.nodes.values()) {
        if (n.kind !== "peer") continue;
        const p = perPeer.get(n.id);
        n.tprog = p ? (p.size > 0 ? Math.min(1, p.done / p.size) : 0.5) : 0;
        if (!p) n.prog = Math.min(n.prog, n.tprog + 0.0001) && n.tprog;
        const e = this.edges.get(n.id);
        if (e) e.el.classList.toggle("hot", !!p);
        if (p && !reduced && this.on) {
          busy = true;
          if (!n.nextChunk || now >= n.nextChunk) { this._emit(this._route(n.id), "chunk", 680); n.nextChunk = now + 95; }
        }
      }

      // Transfers in: chunks converge on this device.
      if (this.inActive.length && this.on) {
        let size = 0, done = 0;
        for (const f of this.inActive) { size += Math.max(f.size, 0); done += f.done; }
        me.tprog = size > 0 ? Math.min(1, done / size) : 0.5;
        if (!reduced) {
          busy = true;
          if (!me.nextChunk || now >= me.nextChunk) {
            // The engine does not say who is sending; follow the device whose traffic is rising, if exactly one is.
            const hot = [...this.rates].filter(([id, r]) => r.rate > 20000 && this.nodes.has(id) && r.inShare > 0.6);
            const from = hot.length === 1 ? this._route(hot[0][0]).slice().reverse() : ["outer", SELF];
            this._emit(from, "chunk in", 680);
            me.nextChunk = now + 95;
          }
        }
      } else me.tprog = 0;

      // Real traffic: packets in proportion to measured throughput.
      if (this.on && !reduced) {
        for (const [id, r] of this.rates) {
          const n = this.nodes.get(id);
          if (!n || n.removing || !n.data || !n.data.online || perPeer.has(id) || r.rate < 600) continue;
          busy = true;
          if (!n.nextPkt || now >= n.nextPkt) {
            const route = this._route(id);
            this._emit(Math.random() < r.inShare ? route.slice().reverse() : route, "pkt", 900);
            n.nextPkt = now + Math.max(140, 1500 - 320 * Math.log10(r.rate / 600 + 1) * 2);
          }
        }
      }

      // Connecting: ripples from the centre.
      if (this.starting && !reduced) {
        busy = true;
        if (now >= this.nextRipple) { this._ripple(0.8); this.nextRipple = now + 1100; }
      }

      // The otter: base mood follows what the app is doing; its eyes follow what matters most.
      const o = this.otter;
      if (o) {
        let base = "idle";
        if (this.demo) base = "idle";
        else if (this.starting) base = "connecting";
        else if (!this.on) base = "sleep";
        else if (this.inActive.length || this.dragging) base = "excited";
        else if (perPeer.size) base = "focus";
        o.setBase(base);
        const pick = (id) => (id ? this.nodes.get(id) : null);
        let tgt = null;
        const busyOut = [...perPeer.keys()][0];
        if (this.hover) tgt = this.hover;
        else if (this.glance && now < this.glance.until) tgt = pick(this.glance.id);
        else if (busyOut) tgt = pick(busyOut);
        else if (this.pointer && this.pointer !== SELF) tgt = pick(this.pointer);
        else if (this.selected) tgt = pick(this.selected);
        else if (this.inActive.length) tgt = { x: VB.cx, y: 0 };
        if (this.glance && now >= this.glance.until) this.glance = null;
        if (!tgt && base === "idle" && this.on && !this.demo) {
          // Now and then, glance at one of the devices.
          if (!this.nextGlance) this.nextGlance = now + 5000 + Math.random() * 7000;
          if (now >= this.nextGlance) {
            const pool = [...this.nodes.values()].filter((n) => n.kind === "peer" && n.data && n.data.online && !n.removing);
            if (pool.length) this.glance = { id: pool[(Math.random() * pool.length) | 0].id, until: now + 1300 };
            this.nextGlance = now + 6000 + Math.random() * 8000;
          }
          clearTimeout(this.glanceTimer);
          this.glanceTimer = setTimeout(() => this.kick(), Math.max(50, this.nextGlance - now + 20));
        }
        if (this.demo && !this.reduced) {
          const a = this.spin * 3.1;
          o.look = [Math.cos(a) * 0.8, Math.sin(a * 0.7) * 0.5];
        } else if (tgt) {
          const dx = tgt.x - VB.cx, dy = tgt.y - VB.cy, l = Math.hypot(dx, dy) || 1;
          o.look = [dx / l, dy / l];
        } else o.look = [0, 0];
        if (o.step(dt)) busy = true;
      }

      // Particles.
      for (let i = this.parts.length - 1; i >= 0; i--) {
        const p = this.parts[i];
        const f = (now - p.t0) / p.dur;
        const pts = p.route.map((id) => this._pos(id));
        if (f >= 1 || pts.some((x) => !x)) { p.el.remove(); this.parts.splice(i, 1); continue; }
        const ease = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
        const [x, y] = along(pts, ease);
        p.el.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        p.el.setAttribute("opacity", (f < 0.1 ? f / 0.1 : f > 0.85 ? (1 - f) / 0.15 : 1).toFixed(2));
      }
      if (this.parts.length) busy = true;

      // Bursts and ripples.
      for (let i = this.fx.length - 1; i >= 0; i--) {
        const x = this.fx[i];
        const f = (now - x.t0) / x.dur;
        if (f < 0) { busy = true; continue; }
        if (f >= 1) { x.el.remove(); this.fx.splice(i, 1); continue; }
        const pos = x.center ? [VB.cx, VB.cy] : this._pos(x.node);
        if (!pos) { x.el.remove(); this.fx.splice(i, 1); continue; }
        const e = 1 - Math.pow(1 - f, 3);
        x.el.setAttribute("cx", pos[0].toFixed(1));
        x.el.setAttribute("cy", pos[1].toFixed(1));
        x.el.setAttribute("r", (x.r0 + (x.r1 - x.r0) * e).toFixed(1));
        x.el.setAttribute("opacity", ((x.o0 || 0.9) * (1 - f)).toFixed(2));
      }
      if (this.fx.length) busy = true;
      return busy;
    }

    // ---- drag and drop ------------------------------------------------------------------

    _bindDrag() {
      const svg = this.svg;
      const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
      svg.addEventListener("dragover", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const n = this._nodeAt(e);
        if (!this.dragging) { this.dragging = true; this.otter.say("Ooh, files!", 1500); }
        this._setHover(n);
        e.dataTransfer.dropEffect = n ? "copy" : "none";
        this.kick();
      });
      svg.addEventListener("dragleave", (e) => { if (!svg.contains(e.relatedTarget)) { this.dragging = false; this._setHover(null); } });
      svg.addEventListener("drop", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const n = this._nodeAt(e);
        this.dragging = false;
        this._setHover(null);
        if (n) this.opts.onDropFiles && this.opts.onDropFiles(n.id, [...e.dataTransfer.files]);
        else this.opts.onDropMiss && this.opts.onDropMiss();
      });
    }

    _nodeAt(e) {
      const ctm = this.svg.getScreenCTM();
      if (!ctm) return null;
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      let best = null, bestD = 48;
      for (const n of this.nodes.values()) {
        if (n.kind !== "peer" || n.removing || !n.data || !n.data.online || !n.data.canDrop) continue;
        const d = Math.hypot(n.x - pt.x, n.y - pt.y);
        if (d < bestD) { best = n; bestD = d; }
      }
      return best;
    }

    _setHover(n) {
      if (this.hover === n) return;
      if (this.hover) this.hover.g.classList.remove("drop-hover");
      this.hover = n;
      if (n) n.g.classList.add("drop-hover");
      this.svg.classList.toggle("dragging", !!n);
      this.opts.onHover && this.opts.onHover(n ? n.data : null);
    }

    // ---- decorative mode (sign-in screen) -------------------------------------------------

    _demoInit() {
      this.on = true;
      this.svg.classList.add("is-on");
      const kinds = ["laptop", "phone", "server", "laptop", "phone", "server", "laptop"];
      this.demoNodes = kinds.map((k, i) => {
        const n = this._node("demo" + i, "peer");
        n.ico.innerHTML = ICONS[k];
        n.g.classList.add("on");
        n.data = { id: n.id, online: true };
        n.a = (i / kinds.length) * 2 * Math.PI;
        n.rr = i % 2 ? R_ON + 18 : R_ON - 22;
        n.x = n.tx = VB.cx + n.rr * Math.cos(n.a); n.y = n.ty = VB.cy + n.rr * Math.sin(n.a);
        n.s = n.ts = 0.8; n.o = n.to = 1;
        const e = { id: n.id, el: mk("path", { class: "edge direct" }, this.L.edges), draw: 1, tdraw: 1, delay: 0, kind: "direct" };
        this.edges.set(n.id, e);
        return n;
      });
      this.rates = new Map(this.demoNodes.map((n, i) => [n.id, { rate: i % 3 ? 4000 : 40000, inShare: 0.5 }]));
    }

    _demoStep(dt) {
      if (this.reduced) return false;
      this.spin += dt * 0.05;
      for (const n of this.demoNodes) {
        const a = n.a + this.spin;
        n.tx = VB.cx + n.rr * Math.cos(a); n.ty = VB.cy + n.rr * Math.sin(a);
        n.x = n.tx; n.y = n.ty;
      }
      return true;
    }
  }

  window.NetWeb = NetWeb;
  window.NetWeb.SELF = SELF;
  window.NetWeb.pathLabel = pathLabel;
  window.NetWeb.osIcon = osIcon;
})();
