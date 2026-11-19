(() => {
  const TZ = "Europe/Amsterdam";
  const POLL_MS = 60_000;
  const PULSE_MS = 10 * 60 * 1000;
  const GLOW_MS = 24 * 60 * 60 * 1000;
  const VIEW = document.body.dataset.view || "map";
  const NS = "http://www.w3.org/2000/svg";

  const state = {
    feed: null,
    fetchedAt: 0,
    selectedId: null,
    cluster: "all",
    query: "",
    camera: { x: 640, y: 400, scale: 1 },
    timer: null,
  };

  const $ = (id) => document.getElementById(id);

  function feedUrl() {
    const configured = (window.LIVE_BOT_MAP && window.LIVE_BOT_MAP.feedUrl) || "";
    if (configured) return configured;
    return "status.json";
  }

  function shortName(name) {
    return (name || "").split("·")[0].trim();
  }

  // Grok Bot avatar palette, tuned to glow on the dark map.
  const AVATAR_HEX = {
    red: "#ff5a5f",
    orange: "#ff9a4a",
    yellow: "#f5d04c",
    green: "#4ee08a",
    blue: "#4d8dff",
    violet: "#a78bfa",
    magenta: "#f472c8",
    brown: "#d4a574",
    cyan: "#5ee4f0",
    pink: "#ff8ab4",
    teal: "#b7e0c9",
  };

  function botHex(bot) {
    const name = String((bot && bot.color) || "").toLowerCase().trim();
    return AVATAR_HEX[name] || "#8b93a7";
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d).replace(",", "") + " Amsterdam";
  }

  function fmtClock(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  }

  function relative(iso, from = Date.now()) {
    if (!iso) return "never";
    const ms = from - new Date(iso).getTime();
    if (ms < 0) return "just now";
    const s = Math.round(ms / 1000);
    if (s < 10) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h}h ago`;
    const days = Math.round(h / 24);
    return `${days}d ago`;
  }

  function nodeRadius(events) {
    // Log scale with a modest cap so one busy bot cannot dominate the map.
    return Math.min(16, 7.5 + Math.log1p(events || 0) * 1.35);
  }

  function clusterLabelPoint(cluster, bots) {
    if (!bots.length) return { x: cluster.hub.x, y: cluster.hub.y - 32 };
    let minX = cluster.hub.x;
    let maxX = cluster.hub.x;
    let minY = cluster.hub.y - 24;
    for (const bot of bots) {
      const reach = nodeRadius(bot.events24h) * 2.25 + 10;
      minX = Math.min(minX, bot.x);
      maxX = Math.max(maxX, bot.x);
      minY = Math.min(minY, bot.y - reach);
    }
    return { x: (minX + maxX) / 2, y: minY - 8 };
  }

  function activityClass(bot, now = Date.now()) {
    if (!bot.lastActive) return "is-dim";
    const age = now - new Date(bot.lastActive).getTime();
    if (age <= PULSE_MS) return "is-pulse";
    if (age <= GLOW_MS) return "is-glow";
    return "is-dim";
  }

  function matches(bot) {
    const q = state.query.trim().toLowerCase();
    const inCluster = state.cluster === "all" || bot.clusterId === state.cluster;
    if (!inCluster) return false;
    if (!q) return true;
    const hay = `${bot.name} ${bot.role} ${bot.cluster} ${bot.doingNow}`.toLowerCase();
    return hay.includes(q);
  }

  function visibleBots(feed = state.feed) {
    if (!feed) return [];
    return feed.bots.filter(matches);
  }

  function svgEl(name, attrs = {}) {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      el.setAttribute(k, String(v));
    }
    return el;
  }

  function ensureMap() {
    const svg = $("map");
    if (!svg || svg.dataset.ready) return svg;
    svg.innerHTML = "";
    const defs = svgEl("defs");
    defs.innerHTML = `
      <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <radialGradient id="hub-fill" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    `;
    svg.appendChild(defs);
    const grid = svgEl("g", { class: "grid", "aria-hidden": "true" });
    for (let x = 80; x <= 1200; x += 80) {
      grid.appendChild(svgEl("line", { x1: x, y1: 40, x2: x, y2: 760, stroke: "rgba(255,255,255,0.025)" }));
    }
    for (let y = 80; y <= 720; y += 80) {
      grid.appendChild(svgEl("line", { x1: 40, y1: y, x2: 1240, y2: y, stroke: "rgba(255,255,255,0.025)" }));
    }
    svg.appendChild(grid);
    svg.appendChild(svgEl("g", { id: "world", class: "world" }));
    svg.dataset.ready = "1";
    svg.addEventListener("click", (e) => {
      if (!e.target.closest(".node")) selectBot(null);
    });
    return svg;
  }

  function applyCamera() {
    const world = $("world");
    if (!world) return;
    const { x, y, scale } = state.camera;
    const tx = 640 - x * scale;
    const ty = 400 - y * scale;
    world.setAttribute("transform", `translate(${tx} ${ty}) scale(${scale})`);
  }

  function zoomTo(bots, padding = 160) {
    if (!bots.length) {
      state.camera = { x: 640, y: 400, scale: 1 };
      applyCamera();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of bots) {
      const r = nodeRadius(b.events24h) + 24;
      minX = Math.min(minX, b.x - r);
      maxX = Math.max(maxX, b.x + r);
      minY = Math.min(minY, b.y - r);
      maxY = Math.max(maxY, b.y + r);
    }
    const w = Math.max(200, maxX - minX + padding * 2);
    const h = Math.max(160, maxY - minY + padding * 2);
    const scale = Math.max(1, Math.min(2.15, 1280 / w, 800 / h));
    state.camera = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
    applyCamera();
  }

  function renderMap(feed, prev) {
    const svg = ensureMap();
    if (!svg) return;
    const world = $("world");
    const prevIds = new Set((prev && prev.bots || []).map((b) => b.id));

    world.innerHTML = "";

    for (const cluster of feed.clusters) {
      const group = svgEl("g", { class: "cluster", "data-cluster": cluster.id });
      const bots = feed.bots.filter((b) => b.clusterId === cluster.id);
      for (const bot of bots) {
        const spoke = svgEl("path", {
          class: "spoke",
          d: `M${cluster.hub.x} ${cluster.hub.y} Q ${(cluster.hub.x + bot.x) / 2} ${(cluster.hub.y + bot.y) / 2 - 18} ${bot.x} ${bot.y}`,
          stroke: cluster.color,
        });
        group.appendChild(spoke);
      }
      group.appendChild(svgEl("circle", {
        class: "hub-core",
        cx: cluster.hub.x, cy: cluster.hub.y, r: 7,
        fill: "url(#hub-fill)", stroke: cluster.color, "stroke-width": 1.5,
      }));
      group.appendChild(svgEl("circle", {
        class: "hub-ring",
        cx: cluster.hub.x, cy: cluster.hub.y, r: 22,
        stroke: cluster.color,
      }));
      const labelAt = clusterLabelPoint(cluster, bots);
      const label = svgEl("text", {
        class: "cluster-label",
        x: labelAt.x, y: labelAt.y,
        "text-anchor": "middle",
      });
      label.textContent = cluster.name;
      group.appendChild(label);
      world.appendChild(group);
    }

    for (const bot of feed.bots) {
      const color = botHex(bot);
      const r = nodeRadius(bot.events24h);
      const g = svgEl("g", {
        class: `node ${activityClass(bot)}`,
        id: `bot-${bot.id}`,
        "data-id": bot.id,
        tabindex: "0",
        role: "button",
        "aria-label": bot.name,
      });
      if (!matches(bot)) g.classList.add("is-hidden");
      if (state.selectedId === bot.id) g.classList.add("is-focus");
      if (!prevIds.has(bot.id) && prev) g.style.opacity = "0";

      g.appendChild(svgEl("circle", {
        class: "bot-glow",
        cx: bot.x, cy: bot.y, r: r * 2.1,
        fill: color, opacity: activityClass(bot) === "is-dim" ? 0 : 0.45,
      }));
      const pulse = svgEl("circle", {
        class: "pulse-ring",
        cx: bot.x, cy: bot.y, r: r + 6,
        stroke: color,
      });
      g.appendChild(pulse);
      g.appendChild(svgEl("circle", {
        class: "bot-core",
        cx: bot.x, cy: bot.y, r,
        fill: "#0b0d13",
        stroke: color,
        "stroke-width": 2.4,
        filter: activityClass(bot) === "is-dim" ? "none" : "url(#soft-glow)",
      }));
      g.appendChild(svgEl("circle", {
        cx: bot.x, cy: bot.y, r: Math.max(3, r * 0.28),
        fill: color,
      }));
      const name = svgEl("text", { class: "bot-label", x: bot.x, y: bot.y + r + 16 });
      name.textContent = shortName(bot.name);
      g.appendChild(name);
      const sub = svgEl("text", { class: "bot-sub", x: bot.x, y: bot.y + r + 28 });
      sub.textContent = bot.doingNow;
      g.appendChild(sub);
      g.appendChild(svgEl("circle", { class: "node-hit", cx: bot.x, cy: bot.y, r: Math.max(22, r + 14) }));

      const activate = (ev) => {
        ev.stopPropagation();
        selectBot(bot.id === state.selectedId ? null : bot.id);
      };
      g.addEventListener("click", activate);
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate(ev);
        }
      });
      world.appendChild(g);
    }

    applyFiltersToMap();
    if (state.cluster !== "all" || state.query.trim()) {
      const vis = visibleBots(feed);
      zoomTo(vis.length ? vis : feed.bots);
    } else {
      state.camera = { x: 640, y: 400, scale: 1 };
      applyCamera();
    }
  }

  function applyFiltersToMap() {
    if (!$("world")) return;
    for (const node of $("world").querySelectorAll(".node")) {
      const bot = state.feed.bots.find((b) => b.id === node.dataset.id);
      node.classList.toggle("is-hidden", !bot || !matches(bot));
      node.classList.toggle("is-focus", state.selectedId && node.dataset.id === state.selectedId);
    }
  }

  function selectBot(id) {
    state.selectedId = id;
    const detail = $("detail");
    if (!detail) return;
    const bot = (state.feed && state.feed.bots.find((b) => b.id === id)) || null;
    if (!bot) {
      detail.hidden = true;
      detail.innerHTML = "";
      applyFiltersToMap();
      return;
    }
    const color = botHex(bot);
    detail.hidden = false;
    detail.style.setProperty("--swatch", color);
    detail.innerHTML = `
      <button class="close" type="button" aria-label="Close">×</button>
      <h2>${escapeHtml(bot.name)}</h2>
      <div class="cluster-line">${escapeHtml(bot.cluster)}</div>
      <p class="role">${escapeHtml(bot.role)}</p>
      <dl>
        <dt>Doing now</dt><dd>${escapeHtml(bot.doingNow)}</dd>
        <dt>Last active</dt><dd>${escapeHtml(fmtTime(bot.lastActive))} · ${escapeHtml(relative(bot.lastActive))}</dd>
        <dt>24h events</dt><dd>${bot.events24h}</dd>
      </dl>
    `;
    detail.querySelector(".close").addEventListener("click", () => selectBot(null));
    applyFiltersToMap();
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderList(feed) {
    const root = $("cards");
    if (!root) return;
    root.innerHTML = "";
    const ordered = [...feed.bots].sort((a, b) => {
      const ca = feed.clusters.findIndex((c) => c.id === a.clusterId);
      const cb = feed.clusters.findIndex((c) => c.id === b.clusterId);
      if (ca !== cb) return ca - cb;
      return a.name.localeCompare(b.name);
    });
    for (const bot of ordered) {
      const color = botHex(bot);
      const cls = activityClass(bot);
      const card = document.createElement("article");
      card.className = `card ${cls}${bot.doingNow === "Idle" ? " is-idle" : ""}`;
      card.style.setProperty("--swatch", color);
      if (!matches(bot)) card.classList.add("is-hidden");
      card.innerHTML = `
        <div class="cluster-line">${escapeHtml(bot.cluster)}</div>
        <h2>${escapeHtml(bot.name)}</h2>
        <p class="role">${escapeHtml(bot.role)}</p>
        <div class="meta">
          <span class="doing">${escapeHtml(bot.doingNow)}</span>
          <span>${bot.events24h} events in 24h</span>
          <span>Last active ${escapeHtml(relative(bot.lastActive))}</span>
        </div>
      `;
      root.appendChild(card);
    }
  }

  function renderFilters(feed) {
    const root = $("filters");
    if (!root) return;
    const items = [{ id: "all", name: "All", color: "#eef2fb" }, ...feed.clusters];
    root.innerHTML = "";
    for (const c of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-pressed", state.cluster === c.id ? "true" : "false");
      btn.style.setProperty("--swatch", c.color);
      btn.innerHTML = `<span class="swatch" style="background:${c.color};color:${c.color}"></span>${escapeHtml(c.name)}`;
      btn.addEventListener("click", () => {
        state.cluster = c.id;
        for (const b of root.querySelectorAll("button")) b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        onFilterChange();
      });
      root.appendChild(btn);
    }
  }

  function renderStats(feed) {
    const root = $("stats");
    if (!root) return;
    const now = Date.now();
    const live = feed.bots.filter((b) => b.lastActive && now - new Date(b.lastActive).getTime() <= PULSE_MS).length;
    const glow = feed.bots.filter((b) => b.lastActive && now - new Date(b.lastActive).getTime() <= GLOW_MS).length;
    const events = feed.bots.reduce((n, b) => n + (b.events24h || 0), 0);
    root.innerHTML = `
      <div><dt>Bots</dt><dd>${feed.bots.length}</dd></div>
      <div><dt>Live now</dt><dd>${live}</dd></div>
      <div><dt>Active 24h</dt><dd>${glow}</dd></div>
      <div><dt>Events 24h</dt><dd>${events}</dd></div>
    `;
  }

  function renderTicker(feed) {
    const root = $("ticker");
    if (!root) return;
    const items = feed.ticker || [];
    if (!items.length) {
      root.innerHTML = `<span class="ticker-item">No recent activity</span>`;
      return;
    }
    const html = items.map((ev) =>
      `<span class="ticker-item"><time>${escapeHtml(fmtClock(ev.at))}</time>${escapeHtml(shortName(ev.bot))} · <span class="action">${escapeHtml(ev.action)}</span></span>`
    ).join("");
    // Duplicate for a seamless loop
    root.innerHTML = html + html;
  }

  function renderBadge() {
    const badge = $("liveBadge");
    const ageEl = $("liveAge");
    if (!badge) return;
    if (!state.feed) {
      badge.dataset.state = "waiting";
      badge.querySelector(".live-text").textContent = "CONNECTING";
      if (ageEl) ageEl.textContent = "";
      return;
    }
    const age = Date.now() - new Date(state.feed.generatedAt).getTime();
    badge.dataset.state = age > 12 * 60 * 1000 ? "stale" : "live";
    badge.querySelector(".live-text").textContent = "LIVE";
    if (ageEl) ageEl.textContent = "· " + relative(state.feed.generatedAt);
  }

  function renderAll(prev) {
    const feed = state.feed;
    if (!feed) return;
    $("statusMsg") && ($("statusMsg").hidden = true);
    renderStats(feed);
    renderFilters(feed);
    renderTicker(feed);
    renderBadge();
    if (VIEW === "map") renderMap(feed, prev);
    else renderList(feed);
    if (state.selectedId) selectBot(state.selectedId);
  }

  function onFilterChange() {
    if (!state.feed) return;
    if (VIEW === "map") {
      applyFiltersToMap();
      const vis = visibleBots();
      if (state.cluster === "all" && !state.query) {
        state.camera = { x: 640, y: 400, scale: 1 };
        applyCamera();
      } else {
        zoomTo(vis.length ? vis : state.feed.bots);
      }
    } else {
      renderList(state.feed);
    }
  }

  async function loadFeed() {
    const url = feedUrl();
    if (!url) throw new Error("Feed URL is not configured");
    const res = await fetch(url, { cache: "no-store", mode: "cors" });
    if (!res.ok) throw new Error(`Feed HTTP ${res.status}`);
    const feed = await res.json();
    if (!feed || !Array.isArray(feed.bots)) throw new Error("Unexpected feed shape");
    const prev = state.feed;
    state.feed = feed;
    state.fetchedAt = Date.now();
    renderAll(prev);
  }

  function startDust() {
    const canvas = $("dust");
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    let w, h, dots, raf;
    function resize() {
      w = canvas.width = window.innerWidth * devicePixelRatio;
      h = canvas.height = window.innerHeight * devicePixelRatio;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      const n = Math.min(90, Math.floor((w * h) / (14000 * devicePixelRatio * devicePixelRatio)));
      dots = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: (Math.random() * 1.3 + 0.3) * devicePixelRatio,
        vx: (Math.random() - 0.5) * 0.08 * devicePixelRatio,
        vy: (Math.random() - 0.5) * 0.08 * devicePixelRatio,
        a: Math.random() * 0.35 + 0.05,
      }));
    }
    function tick() {
      ctx.clearRect(0, 0, w, h);
      for (const d of dots) {
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0) d.x = w;
        if (d.x > w) d.x = 0;
        if (d.y < 0) d.y = h;
        if (d.y > h) d.y = 0;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200, 215, 255, ${d.a})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    }
    resize();
    tick();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else tick();
    });
  }

  function bindControls() {
    const search = $("search");
    if (search) {
      search.addEventListener("input", () => {
        state.query = search.value;
        onFilterChange();
      });
    }
    setInterval(renderBadge, 1000);
  }

  async function start() {
    startDust();
    bindControls();
    const status = $("statusMsg");
    try {
      await loadFeed();
    } catch (err) {
      if (status) status.textContent = "Could not load the live feed.";
      const badge = $("liveBadge");
      if (badge) {
        badge.dataset.state = "error";
        badge.querySelector(".live-text").textContent = "OFFLINE";
      }
      console.warn(err);
    }
    state.timer = setInterval(async () => {
      try { await loadFeed(); }
      catch (err) { console.warn(err); }
    }, POLL_MS);
  }

  start();
})();
