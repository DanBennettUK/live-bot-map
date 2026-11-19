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

  function botTitle(bot) {
    return String((bot && bot.title) || "").trim();
  }

  function isHermes(bot) {
    return String((bot && bot.platform) || "").trim().toLowerCase() === "hermes";
  }

  function captionLines(bot) {
    const title = botTitle(bot);
    const doing = (bot.doingNow || "").trim();
    if (title && doing) {
      const merged = `${title} · ${doing}`;
      if (merged.length <= 26) return [merged];
      return [title, doing];
    }
    return [title || doing].filter(Boolean);
  }

  function textWidth(text, px, tracking = 0) {
    const n = String(text || "").length;
    if (!n) return 0;
    return n * px * 0.62 + Math.max(0, n - 1) * tracking;
  }

  function rectsOverlap(a, b, pad = 4) {
    return a.x - a.w / 2 - pad < b.x + b.w / 2
      && a.x + a.w / 2 + pad > b.x - b.w / 2
      && a.y - a.h / 2 - pad < b.y + b.h / 2
      && a.y + a.h / 2 + pad > b.y - b.h / 2;
  }

  function hitsCircle(rect, cx, cy, r, pad = 6) {
    const dx = Math.max(Math.abs(cx - rect.x) - rect.w / 2, 0);
    const dy = Math.max(Math.abs(cy - rect.y) - rect.h / 2, 0);
    return dx * dx + dy * dy < (r + pad) * (r + pad);
  }

  function botObstacles(bot) {
    const r = nodeRadius(bot.events24h);
    const name = shortName(bot.name);
    const lines = captionLines(bot);
    const nameY = bot.y + r + 14;
    const boxes = [
      { kind: "circle", x: bot.x, y: bot.y, r: Math.max(r * 2.1, 22) },
      { kind: "rect", x: bot.x, y: nameY, w: textWidth(name, 12) + 8, h: 14 },
    ];
    lines.forEach((line, i) => {
      boxes.push({
        kind: "rect",
        x: bot.x,
        y: bot.y + r + 26 + i * 11,
        w: textWidth(line, 9) + 8,
        h: 11,
      });
    });
    return boxes;
  }

  function clusterLabelRect(text, x, y, anchor) {
    const w = textWidth(text.toUpperCase(), 10, 1.6) + 10;
    const h = 12;
    const cx = anchor === "start" ? x + w / 2 : anchor === "end" ? x - w / 2 : x;
    return { kind: "rect", x: cx, y, w, h };
  }

  function clusterBox(cluster, bots) {
    let minX = cluster.hub.x - 24;
    let maxX = cluster.hub.x + 24;
    let minY = cluster.hub.y - 24;
    let maxY = cluster.hub.y + 24;
    for (const bot of bots) {
      const r = nodeRadius(bot.events24h);
      const reach = Math.max(r * 2.1, 22);
      const lines = captionLines(bot);
      minX = Math.min(minX, bot.x - reach);
      maxX = Math.max(maxX, bot.x + reach);
      minY = Math.min(minY, bot.y - reach);
      maxY = Math.max(maxY, bot.y + r + 26 + lines.length * 11);
    }
    return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function clusterLabelPlacement(cluster, bots, obstacles) {
    const name = cluster.name || "";
    if (!bots.length) {
      return { x: cluster.hub.x, y: cluster.hub.y - 32, anchor: "middle" };
    }
    const box = clusterBox(cluster, bots);
    const others = obstacles;
    const candidates = [
      { x: box.cx, y: box.minY - 18, anchor: "middle", prefer: 0 },
      { x: box.maxX + 16, y: box.cy, anchor: "start", prefer: 1 },
      { x: box.minX - 16, y: box.cy, anchor: "end", prefer: 1 },
      { x: box.cx, y: Math.min(788, box.maxY + 16), anchor: "middle", prefer: 2 },
      { x: box.maxX + 14, y: box.minY, anchor: "start", prefer: 2 },
      { x: box.minX - 14, y: box.minY, anchor: "end", prefer: 2 },
      { x: box.maxX + 14, y: box.maxY, anchor: "start", prefer: 3 },
      { x: box.minX - 14, y: box.maxY, anchor: "end", prefer: 3 },
      { x: cluster.hub.x + 36, y: cluster.hub.y - 6, anchor: "start", prefer: 3 },
      { x: cluster.hub.x - 36, y: cluster.hub.y - 6, anchor: "end", prefer: 3 },
    ];
    let best = null;
    for (const cand of candidates) {
      const rect = clusterLabelRect(name, cand.x, cand.y, cand.anchor);
      if (rect.x - rect.w / 2 < 16 || rect.x + rect.w / 2 > 1264 || rect.y < 14 || rect.y > 788) {
        cand.score = 1000 + cand.prefer;
        continue;
      }
      let hits = 0;
      for (const obs of others) {
        if (obs.kind === "circle" && hitsCircle(rect, obs.x, obs.y, obs.r, 2)) hits += 3;
        else if (obs.kind === "rect" && rectsOverlap(rect, obs, 5)) hits += obs.label ? 4 : 2;
      }
      cand.score = hits * 20 + cand.prefer;
      cand.rect = rect;
      if (!best || cand.score < best.score) best = cand;
    }
    const pick = best || candidates[0];
    return { x: pick.x, y: pick.y, anchor: pick.anchor, rect: pick.rect || clusterLabelRect(name, pick.x, pick.y, pick.anchor) };
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
    const hay = `${bot.name} ${bot.title || ""} ${bot.role} ${bot.cluster} ${bot.doingNow} ${bot.platform || ""}`.toLowerCase();
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
    if (world) world.removeAttribute("transform");
  }

  function fitView(bots) {
    const svg = $("map");
    if (!svg) return;
    const list = bots && bots.length ? bots : [];
    const clusters = (state.feed && state.feed.clusters) || [];
    if (!list.length) {
      svg.setAttribute("viewBox", "0 0 1280 800");
      applyCamera();
      return;
    }
    const pad = 40;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const shown = new Set(list.map((b) => b.clusterId));
    for (const bot of list) {
      const r = nodeRadius(bot.events24h);
      const name = shortName(bot.name);
      const lines = captionLines(bot);
      const nameW = textWidth(name, 12);
      const subW = Math.max(0, ...lines.map((line) => textWidth(line, 9)));
      const half = Math.max(nameW, subW, r * 2.2) / 2;
      minX = Math.min(minX, bot.x - half, bot.x - r * 2.1);
      maxX = Math.max(maxX, bot.x + half, bot.x + r * 2.1);
      minY = Math.min(minY, bot.y - Math.max(r * 2.1, 22));
      maxY = Math.max(maxY, bot.y + r + 14 + 12 + lines.length * 11);
    }
    const world = $("world");
    if (world) {
      for (const label of world.querySelectorAll(".cluster-label")) {
        const group = label.closest("[data-cluster]");
        const id = group && group.getAttribute("data-cluster");
        if (id && !shown.has(id)) continue;
        try {
          const bb = label.getBBox();
          minX = Math.min(minX, bb.x);
          maxX = Math.max(maxX, bb.x + bb.width);
          minY = Math.min(minY, bb.y);
          maxY = Math.max(maxY, bb.y + bb.height);
        } catch (err) {
          /* getBBox can fail before layout */
        }
      }
    }
    for (const c of clusters) {
      if (!shown.has(c.id)) continue;
      const lw = textWidth((c.name || "").toUpperCase(), 10, 1.6);
      minX = Math.min(minX, c.hub.x - Math.max(28, lw / 2));
      maxX = Math.max(maxX, c.hub.x + Math.max(28, lw / 2));
      minY = Math.min(minY, c.hub.y - 48);
      maxY = Math.max(maxY, c.hub.y + 28);
    }
    const w = Math.max(220, maxX - minX + pad * 2);
    const h = Math.max(180, maxY - minY + pad * 2);
    const x = minX - pad;
    const y = minY - pad;
    svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    applyCamera();
    state.camera = { x: x + w / 2, y: y + h / 2, scale: 1 };
    const rect = svg.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const scale = Math.min(rect.width / w, rect.height / h);
    const compact = scale < 0.72 || rect.height < 430 || rect.width < 520;
    svg.classList.toggle("is-compact", compact);
    svg.style.setProperty("--label-size", `${Math.min(26, Math.max(12, 10.8 / scale))}px`);
    svg.style.setProperty("--title-size", `${Math.min(18, Math.max(9, 9.5 / scale))}px`);
    svg.style.setProperty("--cluster-size", `${Math.min(16, Math.max(9, 9.5 / scale))}px`);
    svg.style.setProperty("--pill-size", `${Math.min(12, Math.max(6.5, 7 / scale))}px`);
  }

  function zoomTo(bots) {
    fitView(bots && bots.length ? bots : ((state.feed && state.feed.bots) || []));
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
      world.appendChild(group);
    }

    const obstacles = [];
    for (const bot of feed.bots) {
      for (const box of botObstacles(bot)) obstacles.push({ ...box, bot });
    }
    for (const cluster of feed.clusters) {
      obstacles.push({ kind: "circle", x: cluster.hub.x, y: cluster.hub.y, r: 24 });
    }
    for (const cluster of feed.clusters) {
      const group = [...world.querySelectorAll(".cluster")].find((g) => g.getAttribute("data-cluster") === cluster.id);
      const bots = feed.bots.filter((b) => b.clusterId === cluster.id);
      const labelAt = clusterLabelPlacement(cluster, bots, obstacles);
      const label = svgEl("text", {
        class: "cluster-label",
        x: labelAt.x, y: labelAt.y,
        "text-anchor": labelAt.anchor || "middle",
      });
      label.textContent = cluster.name;
      if (group) group.appendChild(label);
      else world.appendChild(label);
      if (labelAt.rect) obstacles.push({ ...labelAt.rect, label: true });
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
        "aria-label": botTitle(bot) ? `${shortName(bot.name)}, ${botTitle(bot)}` : shortName(bot.name),
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
      if (isHermes(bot)) {
        g.appendChild(svgEl("circle", {
          class: "hermes-ring",
          cx: bot.x, cy: bot.y, r: r + 5,
        }));
      }
      const name = svgEl("text", { class: "bot-label", x: bot.x, y: bot.y + r + 14 });
      name.textContent = shortName(bot.name);
      g.appendChild(name);
      const lines = captionLines(bot);
      lines.forEach((line, i) => {
        const isDoing = !botTitle(bot) || (lines.length > 1 && i === lines.length - 1);
        const sub = svgEl("text", {
          class: isDoing ? "bot-sub" : "bot-title",
          x: bot.x,
          y: bot.y + r + 26 + i * 11,
        });
        sub.textContent = line;
        g.appendChild(sub);
      });
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
    const vis = visibleBots(feed);
    zoomTo(vis.length ? vis : feed.bots);
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
      <div class="detail-head">
        <h2>${escapeHtml(shortName(bot.name))}</h2>
        ${isHermes(bot) ? `<span class="platform-pill">Hermes</span>` : ""}
      </div>
      ${botTitle(bot) ? `<div class="bot-title">${escapeHtml(botTitle(bot))}</div>` : ""}
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
        <div class="card-head">
          <h2>${escapeHtml(shortName(bot.name))}</h2>
          ${isHermes(bot) ? `<span class="platform-pill">Hermes</span>` : ""}
        </div>
        ${botTitle(bot) ? `<p class="bot-title">${escapeHtml(botTitle(bot))}</p>` : ""}
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
    if (feed.bots.some(isHermes)) {
      const legend = document.createElement("span");
      legend.className = "legend-hermes";
      legend.setAttribute("aria-label", "Hermes marks agents on the Hermes platform");
      legend.innerHTML = `<span class="platform-pill">Hermes</span>`;
      root.appendChild(legend);
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
      zoomTo(vis.length ? vis : state.feed.bots);
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
    let fitTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => {
        if (VIEW !== "map" || !state.feed) return;
        const vis = visibleBots();
        zoomTo(vis.length ? vis : state.feed.bots);
      }, 80);
    });
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
