const state = {
  cachedGames: [],
  engagementColorMap: new Map(),
  engagementPaletteIndex: 0,
  insightBuckets: {
    metadata: {},
    order: [],
    summaries: {},
  },
};

const ENGAGEMENT_PALETTE = [
  "#60a5fa",
  "#f472b6",
  "#facc15",
  "#34d399",
  "#a855f7",
  "#f97316",
  "#38bdf8",
  "#f87171",
];

const ENGAGEMENT_OTHER_COLOR = "rgba(148, 163, 184, 0.55)";

const STATUS_TAXONOMY = [
  {
    value: "backlog",
    label: "Backlog",
    requiresPurchaseDate: true,
    group: "owned",
    emptyCopy: "No backlog games yet.",
  },
  {
    value: "playing",
    label: "Playing",
    requiresPurchaseDate: true,
    group: "owned",
    emptyCopy: "No games are currently marked as playing.",
  },
  {
    value: "occasional",
    label: "Occasional",
    requiresPurchaseDate: true,
    group: "owned",
    emptyCopy: "No occasional rotation titles yet.",
  },
  {
    value: "story_clear",
    label: "Story clear",
    requiresPurchaseDate: true,
    group: "owned",
    emptyCopy: "No story clears logged yet.",
  },
  {
    value: "full_clear",
    label: "Full clear",
    requiresPurchaseDate: true,
    group: "owned",
    emptyCopy: "No full clears recorded yet.",
  },
  {
    value: "dropped",
    label: "Dropped",
    requiresPurchaseDate: true,
    group: "owned",
    emptyCopy: "No dropped games yet.",
  },
  {
    value: "wishlist",
    label: "Wishlist",
    requiresPurchaseDate: false,
    group: "wishlist",
    emptyCopy: "No wishlist games yet.",
  },
];

const STATUS_LOOKUP = Object.fromEntries(
  STATUS_TAXONOMY.map((entry) => [entry.value, entry])
);
const OWNED_STATUS_SET = new Set(
  STATUS_TAXONOMY.filter((entry) => entry.requiresPurchaseDate).map(
    (entry) => entry.value
  )
);
const DEFAULT_STATUS = "backlog";

function getStatusDefinition(value) {
  return STATUS_LOOKUP[String(value || "").toLowerCase()] || null;
}

function getStatusLabel(value) {
  const definition = getStatusDefinition(value);
  return definition ? definition.label : value || "Unknown";
}

function statusRequiresPurchase(value) {
  return OWNED_STATUS_SET.has(String(value || "").toLowerCase());
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = response.statusText || "Request failed";
    try {
      const data = await response.json();
      message = data.error || message;
    } catch (error) {
      /* ignore JSON parse issues */
    }
    throw new Error(message);
  }
  return response.json();
}

function buildTagElements(items) {
  return items.map((item) => `<span class="tag">${item}</span>`).join(" ");
}

function formatDateForDisplay(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString();
  } catch (error) {
    return value;
  }
}

function updateMetricValue(element, value) {
  if (!element) return;
  if (value !== null && value !== undefined) {
    element.textContent = value;
    return;
  }
  const placeholder = element.dataset?.placeholderText;
  element.textContent = placeholder || "—";
}

function formatDays(value, { decimals = null } = {}) {
  if (!Number.isFinite(value)) return "—";
  let resolvedDecimals = decimals;
  if (resolvedDecimals === null) {
    resolvedDecimals = Math.abs(value) < 10 ? 1 : 0;
  }
  const rounded = Number(value.toFixed(resolvedDecimals));
  const suffix = Math.abs(rounded) === 1 ? "day" : "days";
  return `${rounded.toLocaleString()} ${suffix}`;
}

function formatDaysRange(lower, upper) {
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    return "—";
  }
  const minValue = Number(lower.toFixed(0)).toLocaleString();
  const maxValue = Number(upper.toFixed(0)).toLocaleString();
  return `${minValue} – ${maxValue} days`;
}

async function fetchAndCacheGames({ force = false } = {}) {
  if (!force && state.cachedGames.length > 0) {
    return state.cachedGames;
  }
  const games = await fetchJSON("/api/games");
  state.cachedGames = games;
  return games;
}

function renderImportLog(container, list, events) {
  if (!container || !list) return;
  list.innerHTML = "";
  if (!Array.isArray(events) || events.length === 0) {
    container.classList.add("hidden");
    container.open = false;
    return;
  }

  events.forEach((event) => {
    const item = document.createElement("li");
    const statusLabel = (event.status || "unknown").toUpperCase();
    const rowLabel = event.row ? `Row ${event.row}` : null;
    const titleLabel = event.title || null;
    const headingParts = [rowLabel, titleLabel].filter(Boolean);
    const heading = headingParts.length > 0 ? headingParts.join(" · ") : "Row";
    const detailParts = [];
    if (event.reason) detailParts.push(event.reason);
    if (event.source) detailParts.push(`source: ${event.source}`);
    if (event.steam_app_id) detailParts.push(`app: ${event.steam_app_id}`);
    item.textContent = `[${statusLabel}] ${heading}${
      detailParts.length ? ` — ${detailParts.join("; ")}` : ""
    }`;
    list.appendChild(item);
  });

  container.classList.remove("hidden");
  container.open = true;
}

async function initBacklogImportPage() {
  const form = document.getElementById("backlog-import-form");
  if (!form) return;

  const fileInput = document.getElementById("backlog-import-file");
  const result = document.getElementById("backlog-import-result");
  const summary = document.getElementById("backlog-import-summary");
  const importedList = document.getElementById("backlog-import-imported");
  const skippedList = document.getElementById("backlog-import-skipped");
  const logContainer = document.getElementById("backlog-import-log");
  const logList = document.getElementById("backlog-import-log-list");

  function resetSummary() {
    if (importedList) importedList.innerHTML = "";
    if (skippedList) skippedList.innerHTML = "";
    summary?.classList.add("hidden");
    if (logList) logList.innerHTML = "";
    if (logContainer) {
      logContainer.classList.add("hidden");
      logContainer.open = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      if (result) {
        result.textContent = "Choose a CSV file to import.";
      }
      return;
    }

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    if (result) {
      result.textContent = "Importing backlog...";
    }
    resetSummary();

    try {
      const payload = await fetchJSON("/api/import/backlog", {
        method: "POST",
        body: formData,
      });

      if (result) {
        result.textContent = `Imported ${payload.imported_count} game(s), skipped ${payload.skipped_count}.`;
      }

      if (Array.isArray(payload.imported) && importedList) {
        payload.imported.forEach((game) => {
          const item = document.createElement("li");
          item.innerHTML = `<strong>${game.title}</strong>${
            game.steam_app_id ? ` · Steam App ID ${game.steam_app_id}` : ""
          }`;
          importedList.appendChild(item);
        });
      }

      if (Array.isArray(payload.skipped) && skippedList) {
        payload.skipped.forEach((entry) => {
          const item = document.createElement("li");
          const label = entry.title || `Row ${entry.row}`;
          const rowInfo = entry.title && entry.row ? ` (Row ${entry.row})` : "";
          const reason = entry.reason ? ` — ${entry.reason}` : "";
          item.innerHTML = `<strong>${label}${rowInfo}</strong>${reason}`;
          skippedList.appendChild(item);
        });
      }

      if (
        summary &&
        ((payload.imported && payload.imported.length > 0) ||
          (payload.skipped && payload.skipped.length > 0))
      ) {
        summary.classList.remove("hidden");
      }

      renderImportLog(logContainer, logList, payload.events);

      form.reset();
      if (fileInput) {
        fileInput.value = "";
      }
      await fetchAndCacheGames({ force: true });
    } catch (error) {
      if (result) {
        result.textContent = error instanceof Error ? error.message : String(error);
      }
    }
  });
}

async function initWishlistCsvImportPage() {
  const form = document.getElementById("wishlist-csv-import-form");
  if (!form) return;

  const fileInput = document.getElementById("wishlist-csv-import-file");
  const result = document.getElementById("wishlist-csv-import-result");
  const summary = document.getElementById("wishlist-csv-import-summary");
  const importedList = document.getElementById("wishlist-csv-import-imported");
  const skippedList = document.getElementById("wishlist-csv-import-skipped");
  const logContainer = document.getElementById("wishlist-csv-import-log");
  const logList = document.getElementById("wishlist-csv-import-log-list");

  function resetSummary() {
    if (importedList) importedList.innerHTML = "";
    if (skippedList) skippedList.innerHTML = "";
    summary?.classList.add("hidden");
    if (logList) logList.innerHTML = "";
    if (logContainer) {
      logContainer.classList.add("hidden");
      logContainer.open = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      if (result) {
        result.textContent = "Choose a CSV file to import.";
      }
      return;
    }

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    if (result) {
      result.textContent = "Importing wishlist...";
    }
    resetSummary();

    try {
      const payload = await fetchJSON("/api/import/wishlist", {
        method: "POST",
        body: formData,
      });

      if (result) {
        result.textContent = `Imported ${payload.imported_count} game(s), skipped ${payload.skipped_count}.`;
      }

      if (Array.isArray(payload.imported) && importedList) {
        payload.imported.forEach((game) => {
          const item = document.createElement("li");
          const details = [];
          if (game.steam_app_id) {
            details.push(`Steam App ID ${game.steam_app_id}`);
          }
          if (game.thoughts) {
            details.push(`Thoughts: ${game.thoughts}`);
          }
          item.innerHTML = `<strong>${game.title}</strong>${
            details.length ? ` · ${details.join(" · ")}` : ""
          }`;
          importedList.appendChild(item);
        });
      }

      if (Array.isArray(payload.skipped) && skippedList) {
        payload.skipped.forEach((entry) => {
          const item = document.createElement("li");
          const label = entry.title || `Row ${entry.row}`;
          const rowInfo = entry.title && entry.row ? ` (Row ${entry.row})` : "";
          const reason = entry.reason ? ` — ${entry.reason}` : "";
          item.innerHTML = `<strong>${label}${rowInfo}</strong>${reason}`;
          skippedList.appendChild(item);
        });
      }

      if (
        summary &&
        ((payload.imported && payload.imported.length > 0) ||
          (payload.skipped && payload.skipped.length > 0))
      ) {
        summary.classList.remove("hidden");
      }

      renderImportLog(logContainer, logList, payload.events);

      form.reset();
      if (fileInput) {
        fileInput.value = "";
      }
      await fetchAndCacheGames({ force: true });
    } catch (error) {
      if (result) {
        result.textContent = error instanceof Error ? error.message : String(error);
      }
    }
  });
}

function formatPercent(value, fractionDigits = 1) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function formatAverageElo(value) {
  if (!Number.isFinite(value)) return "Avg ELO —";
  return `Avg ELO ${Math.round(value)}`;
}

function hexToRgba(hex, alpha = 0.15) {
  if (!hex) return null;
  const normalized = hex.replace(/[^0-9a-fA-F]/g, "");
  if (normalized.length !== 3 && normalized.length !== 6) {
    return null;
  }
  const chunkSize = normalized.length === 3 ? 1 : 2;
  const values = normalized.match(new RegExp(`.{${chunkSize}}`, "g"));
  if (!values) return null;
  const channels = values.map((chunk) => {
    const expanded = chunkSize === 1 ? chunk + chunk : chunk;
    const parsed = parseInt(expanded, 16);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
  if (channels.length !== 3) return null;
  const [r, g, b] = channels;
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
}

function resolveBucketLabel(bucket, metadata = {}) {
  if (!bucket || bucket === "total") {
    return "All statuses";
  }
  const entry = metadata[bucket];
  if (entry && entry.label) {
    return entry.label;
  }
  return String(bucket)
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown";
}

function resolveBucketDescription(bucket, metadata = {}) {
  if (!bucket || bucket === "total") {
    return "Blend every tracked list together for a big-picture view.";
  }
  const entry = metadata[bucket];
  return entry?.description || "";
}

function getBucketColor(bucket, metadata = {}) {
  if (!bucket || bucket === "total") return null;
  const entry = metadata[bucket];
  return entry?.color || null;
}

function getBucketOrderIndex(bucket, order = []) {
  const index = order.indexOf(bucket);
  return index === -1 ? order.length : index;
}

function formatPlaytimeMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "0 hrs";
  }
  const hours = minutes / 60;
  const formatted = hours >= 10 ? hours.toFixed(1) : hours.toFixed(2);
  return `${Number(formatted)} hr${Number(formatted) === 1 ? "" : "s"}`;
}

function formatScorePoints(value) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value)} pts`;
}

function getEngagementColor(key) {
  if (!state.engagementColorMap) {
    state.engagementColorMap = new Map();
  }
  const cache = state.engagementColorMap;
  if (!key) {
    return ENGAGEMENT_OTHER_COLOR;
  }
  const normalized = String(key).toLowerCase();
  if (!cache.has(normalized)) {
    const paletteIndex = state.engagementPaletteIndex % ENGAGEMENT_PALETTE.length;
    cache.set(normalized, ENGAGEMENT_PALETTE[paletteIndex]);
    state.engagementPaletteIndex += 1;
  }
  return cache.get(normalized);
}

function formatMinutesAxis(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0";
  if (minutes >= 720) {
    return `${Math.round(minutes / 60)}h`;
  }
  if (minutes >= 120) {
    return `${(minutes / 60).toFixed(1)}h`;
  }
  if (minutes >= 60) {
    return `${(minutes / 60).toFixed(1)}h`;
  }
  return `${Math.round(minutes)}m`;
}

function formatSentimentValue(value) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value)} pts`;
}

function renderEngagementTrend(root, summary) {
  const chart = root.querySelector('[data-insights-chart="engagement"]');
  if (!chart) return;

  const canvas = chart.querySelector(".insights-chart__canvas");
  if (!canvas) return;

  canvas.innerHTML = "";
  canvas.dataset.state = "loaded";

  const timeline = Array.isArray(summary?.timeline) ? summary.timeline : [];
  if (timeline.length === 0) {
    canvas.innerHTML =
      '<p class="engagement-chart__empty">Log a few play sessions to visualize engagement trends.</p>';
    return;
  }

  const minutesValues = timeline.map((entry) => Number(entry.total_minutes) || 0);
  const maxMinutes = Math.max(...minutesValues);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
    canvas.innerHTML =
      '<p class="engagement-chart__empty">Sessions without playtime cannot build a timeline yet.</p>';
    return;
  }

  const svgNS = "http://www.w3.org/2000/svg";
  const width = Math.max(360, timeline.length * 110);
  const height = 280;
  const padding = { top: 28, right: 36, bottom: 64, left: 68 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "engagement-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Timeline comparing playtime and sentiment");

  const baseline = document.createElementNS(svgNS, "line");
  baseline.setAttribute("x1", padding.left);
  baseline.setAttribute("x2", width - padding.right);
  baseline.setAttribute("y1", height - padding.bottom);
  baseline.setAttribute("y2", height - padding.bottom);
  baseline.setAttribute("stroke", "rgba(148, 163, 184, 0.4)");
  baseline.setAttribute("stroke-width", 1);
  svg.appendChild(baseline);

  const tickCount = Math.max(3, Math.min(6, Math.round(maxMinutes / 90)));
  for (let i = 0; i <= tickCount; i += 1) {
    const ratio = i / tickCount;
    const value = maxMinutes * ratio;
    const y = height - padding.bottom - ratio * chartHeight;

    const gridLine = document.createElementNS(svgNS, "line");
    gridLine.setAttribute("x1", padding.left);
    gridLine.setAttribute("x2", width - padding.right);
    gridLine.setAttribute("y1", y);
    gridLine.setAttribute("y2", y);
    gridLine.setAttribute("stroke", "rgba(148, 163, 184, 0.2)");
    gridLine.setAttribute("stroke-width", i === 0 ? 1.5 : 1);
    svg.appendChild(gridLine);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", padding.left - 12);
    label.setAttribute("y", y + 4);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "engagement-chart__axis");
    label.textContent = formatMinutesAxis(value);
    svg.appendChild(label);
  }

  const slotWidth = chartWidth / timeline.length;
  const barWidth = Math.max(18, Math.min(52, slotWidth * 0.55));
  const sentimentPoints = [];

  timeline.forEach((entry, index) => {
    const totalMinutes = Number(entry.total_minutes) || 0;
    const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2;
    let stackedHeight = 0;

    const segments = Array.isArray(entry.top_titles) ? entry.top_titles : [];
    segments.forEach((segment) => {
      const minutes = Number(segment.minutes) || 0;
      if (minutes <= 0) return;
      const heightRatio = minutes / maxMinutes;
      const barHeight = heightRatio * chartHeight;
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", x);
      rect.setAttribute(
        "y",
        height - padding.bottom - stackedHeight - barHeight
      );
      rect.setAttribute("width", barWidth);
      rect.setAttribute("height", barHeight);
      rect.setAttribute(
        "fill",
        segment.title === "Other Titles"
          ? ENGAGEMENT_OTHER_COLOR
          : getEngagementColor(segment.game_id || segment.title)
      );
      rect.setAttribute("rx", 6);
      rect.setAttribute("ry", 6);

      const tooltip = document.createElementNS(svgNS, "title");
      const shareLabel = formatPercent(segment.share || 0, 0);
      tooltip.textContent = `${segment.title} · ${formatPlaytimeMinutes(minutes)} (${shareLabel})`;
      rect.appendChild(tooltip);

      svg.appendChild(rect);
      stackedHeight += barHeight;
    });

    const center = x + barWidth / 2;
    const sentiment = Number(entry.average_sentiment);
    if (Number.isFinite(sentiment)) {
      const clamped = Math.max(0, Math.min(100, sentiment));
      const y = height - padding.bottom - (clamped / 100) * chartHeight;
      sentimentPoints.push({ x: center, y, sentiment, label: entry.label });
    }

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", center);
    label.setAttribute("y", height - padding.bottom + 20);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "engagement-chart__axis engagement-chart__axis--x");
    label.textContent = entry.label || `Period ${index + 1}`;
    svg.appendChild(label);
  });

  if (sentimentPoints.length > 0) {
    const path = document.createElementNS(svgNS, "path");
    const pathCommands = sentimentPoints
      .map((point, idx) => `${idx === 0 ? "M" : "L"}${point.x} ${point.y}`)
      .join(" ");
    path.setAttribute("d", pathCommands);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--accent)");
    path.setAttribute("stroke-width", 2.5);
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);

    sentimentPoints.forEach((point) => {
      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", point.x);
      dot.setAttribute("cy", point.y);
      dot.setAttribute("r", 4.5);
      dot.setAttribute("fill", "var(--accent)");

      const tooltip = document.createElementNS(svgNS, "title");
      tooltip.textContent = `${point.label}: ${formatSentimentValue(point.sentiment)}`;
      dot.appendChild(tooltip);

      svg.appendChild(dot);
    });
  }

  canvas.appendChild(svg);

  const latest = timeline[timeline.length - 1];
  if (latest && Array.isArray(latest.top_titles) && latest.top_titles.length > 0) {
    const legend = document.createElement("ul");
    legend.className = "engagement-chart__legend";
    latest.top_titles
      .filter((entry) => (entry.minutes || 0) > 0)
      .slice(0, 4)
      .forEach((entry) => {
        const item = document.createElement("li");
        item.className = "engagement-chart__legend-item";

        const swatch = document.createElement("span");
        swatch.className = "engagement-chart__swatch";
        swatch.style.backgroundColor =
          entry.title === "Other Titles"
            ? ENGAGEMENT_OTHER_COLOR
            : getEngagementColor(entry.game_id || entry.title);
        item.appendChild(swatch);

        const label = document.createElement("span");
        const shareLabel = formatPercent(entry.share || 0, 0);
        label.innerHTML = `<strong>${entry.title}</strong> · ${formatPlaytimeMinutes(
          entry.minutes
        )} (${shareLabel})`;
        item.appendChild(label);

        legend.appendChild(item);
      });

    canvas.appendChild(legend);
  }
}

function calloutHeading(type) {
  switch (type) {
    case "spike":
      return "Momentum spike";
    case "dip":
      return "Engagement dip";
    case "burnout":
      return "Mood warning";
    default:
      return "Insight";
  }
}

function renderEngagementCallouts(root, summary) {
  const container = root.querySelector("[data-insights-callouts]");
  if (!container) return;

  container.innerHTML = "";
  container.dataset.state = "loaded";

  const callouts = Array.isArray(summary?.callouts) ? summary.callouts : [];
  if (callouts.length === 0) {
    const placeholder = document.createElement("p");
    placeholder.className = "insights-callouts__empty";
    placeholder.textContent =
      container.dataset.placeholderText || "No major spikes or dips detected yet.";
    container.appendChild(placeholder);
    return;
  }

  const timeline = Array.isArray(summary?.timeline) ? summary.timeline : [];
  callouts.slice(0, 4).forEach((callout) => {
    const card = document.createElement("article");
    card.className = `insights-callout insights-callout--${callout.type}`;

    const heading = document.createElement("h3");
    heading.textContent = calloutHeading(callout.type);
    card.appendChild(heading);

    const summaryText = document.createElement("p");
    summaryText.className = "insights-callout__summary";
    summaryText.textContent = callout.label || "Notable change detected.";
    card.appendChild(summaryText);

    if (Number.isFinite(callout.percent_change)) {
      const percent = document.createElement("p");
      percent.className = "insights-callout__meta";
      const value = callout.percent_change;
      const formatted = `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}%`;
      percent.textContent = `Change vs prior period: ${formatted}`;
      card.appendChild(percent);
    }

    if (Number.isFinite(callout.change_minutes)) {
      const delta = document.createElement("p");
      delta.className = "insights-callout__meta";
      const direction = callout.change_minutes >= 0 ? "+" : "−";
      delta.textContent = `Playtime delta: ${direction}${formatPlaytimeMinutes(
        Math.abs(callout.change_minutes)
      )}`;
      card.appendChild(delta);
    }

    const periodEntry = timeline.find((entry) => entry.period_start === callout.period_start);
    if (periodEntry) {
      const snapshot = document.createElement("p");
      snapshot.className = "insights-callout__snapshot";
      const sentimentLabel = formatSentimentValue(periodEntry.average_sentiment);
      snapshot.textContent = `${periodEntry.label}: ${formatPlaytimeMinutes(
        periodEntry.total_minutes
      )}, mood ${sentimentLabel}, ${periodEntry.active_titles} active title${
        periodEntry.active_titles === 1 ? "" : "s"
      }`;
      card.appendChild(snapshot);
    }

    const drivers = callout.drivers || {};
    if (Array.isArray(drivers.titles) && drivers.titles.length > 0) {
      const list = document.createElement("ul");
      list.className = "insights-callout__drivers";
      drivers.titles.slice(0, 3).forEach((driver) => {
        const item = document.createElement("li");
        const swatch = document.createElement("span");
        swatch.className = "insights-callout__marker";
        swatch.style.backgroundColor = getEngagementColor(driver.game_id || driver.title);
        item.appendChild(swatch);

        const label = document.createElement("span");
        const minutesLabel = formatPlaytimeMinutes(driver.minutes);
        const shareLabel = formatPercent(driver.share || 0, 0);
        if (driver.game_id) {
          const link = document.createElement("a");
          link.href = `/games/${driver.game_id}`;
          link.textContent = driver.title;
          link.className = "insights-callout__link";
          label.appendChild(link);
        } else {
          label.textContent = driver.title || "Untitled";
        }
        const detail = document.createElement("span");
        detail.className = "insights-callout__detail";
        detail.textContent = ` · ${minutesLabel} (${shareLabel})`;
        label.appendChild(detail);

        item.appendChild(label);
        list.appendChild(item);
      });
      card.appendChild(list);
    }

    if (Array.isArray(drivers.genres) && drivers.genres.length > 0) {
      const genreList = document.createElement("p");
      genreList.className = "insights-callout__genres";
      const fragments = drivers.genres.slice(0, 3).map((genre) => {
        const share = formatPercent(genre.share || 0, 0);
        return `${genre.genre}: ${share}`;
      });
      genreList.textContent = `Leading genres: ${fragments.join(", ")}`;
      card.appendChild(genreList);
    }

    container.appendChild(card);
  });
}

function describeDominance(entry, metadata = {}) {
  if (!entry || !entry.dominant) {
    return "Balanced mix";
  }
  if (entry.dominant === "balanced") {
    return "Balanced mix";
  }
  const label = resolveBucketLabel(entry.dominant, metadata);
  const share = entry.dominant_share;
  if (Number.isFinite(share) && share > 0) {
    return `${label} leads (${formatPercent(share)})`;
  }
  return `${label} leads`;
}

function renderGenreInsights(root, summary) {
  const genreChart = root.querySelector('[data-insights-chart="genre"]');
  if (!genreChart) return;

  const canvas = genreChart.querySelector(".insights-chart__canvas");
  if (!canvas) return;

  canvas.innerHTML = "";
  canvas.dataset.state = "loaded";

  const genres = Array.isArray(summary?.genres) ? summary.genres : [];
  if (genres.length === 0) {
    canvas.innerHTML =
      '<p class="genre-insights__empty">No genre insights are available yet. Add more games with genres to see trends.</p>';
    return;
  }

  const bucketMetadata = summary?.bucket_metadata || {};
  const bucketOrder = Array.isArray(summary?.bucket_order)
    ? summary.bucket_order
    : Object.keys(bucketMetadata);
  const bucketSummaries = summary?.buckets || {};
  const availableBuckets = Array.from(
    new Set(
      (bucketOrder.length > 0 ? bucketOrder : Object.keys(bucketSummaries)).filter(
        Boolean
      )
    )
  );

  state.insightBuckets = {
    metadata: bucketMetadata,
    order: bucketOrder,
    summaries: bucketSummaries,
  };

  const metrics = [
    {
      key: "share",
      label: "Weighted share",
      extractor: (source) => source?.share ?? 0,
      formatter: (value) => `${formatPercent(value)} share`,
    },
    {
      key: "count",
      label: "Game count",
      extractor: (source) => source?.count ?? 0,
      formatter: (value) => {
        const rounded = Math.round(value);
        const suffix = rounded === 1 ? " game" : " games";
        return `${rounded.toLocaleString()}${suffix}`;
      },
    },
    {
      key: "average_elo",
      label: "Avg ELO",
      extractor: (source) => source?.average_elo ?? null,
      formatter: (value) =>
        Number.isFinite(value) ? `${Math.round(value)} ELO` : "No rating data",
    },
  ];

  let activeMetric = metrics[0];
  let activeBucket = "total";

  const controls = document.createElement("div");
  controls.className = "genre-insights__controls";

  const controlBar = document.createElement("div");
  controlBar.className = "genre-insights__control-bar";

  const metricGroup = document.createElement("div");
  metricGroup.className = "genre-insights__toggle-group";
  const metricLabel = document.createElement("span");
  metricLabel.className = "genre-insights__group-label";
  metricLabel.textContent = "Rank by";
  metricGroup.appendChild(metricLabel);

  metrics.forEach((metric) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "genre-insights__toggle";
    button.dataset.metric = metric.key;
    button.textContent = metric.label;
    if (metric.key === activeMetric.key) {
      button.classList.add("is-active");
    }
    button.addEventListener("click", () => {
      if (activeMetric.key === metric.key) return;
      activeMetric = metric;
      metricGroup
        .querySelectorAll(".genre-insights__toggle.is-active")
        .forEach((element) => element.classList.remove("is-active"));
      button.classList.add("is-active");
      updateLists();
    });
    metricGroup.appendChild(button);
  });
  controlBar.appendChild(metricGroup);

  const bucketGroup = document.createElement("div");
  bucketGroup.className = "genre-insights__toggle-group";
  const bucketGroupLabel = document.createElement("span");
  bucketGroupLabel.className = "genre-insights__group-label";
  bucketGroupLabel.textContent = "Focus on";
  bucketGroup.appendChild(bucketGroupLabel);

  const viewModes = [
    {
      key: "total",
      label: resolveBucketLabel("total"),
      description: resolveBucketDescription("total", bucketMetadata),
    },
    ...availableBuckets.map((bucket) => ({
      key: bucket,
      label: resolveBucketLabel(bucket, bucketMetadata),
      description: resolveBucketDescription(bucket, bucketMetadata),
    })),
  ];

  viewModes.forEach((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "genre-insights__toggle";
    button.dataset.bucket = mode.key;
    button.textContent = mode.label;
    if (mode.key === activeBucket) {
      button.classList.add("is-active");
      button.setAttribute("aria-pressed", "true");
    } else {
      button.setAttribute("aria-pressed", "false");
    }
    const hasData = bucketHasData(mode.key);
    if (mode.description) {
      button.title = mode.description;
    }
    if (!hasData) {
      button.classList.add("is-empty");
      if (!button.title) {
        button.title = `${mode.label}: no tracked data yet.`;
      }
    }
    button.addEventListener("click", () => {
      if (activeBucket === mode.key) {
        return;
      }
      activeBucket = mode.key;
      bucketGroup
        .querySelectorAll(".genre-insights__toggle.is-active")
        .forEach((element) => {
          element.classList.remove("is-active");
          element.setAttribute("aria-pressed", "false");
        });
      button.classList.add("is-active");
      button.setAttribute("aria-pressed", "true");
      bucketHint.textContent = getBucketHint(activeBucket);
      updateLists();
    });
    bucketGroup.appendChild(button);
  });

  controlBar.appendChild(bucketGroup);
  controls.appendChild(controlBar);

  const bucketHint = document.createElement("p");
  bucketHint.className = "genre-insights__hint";
  bucketHint.textContent = getBucketHint(activeBucket);
  controls.appendChild(bucketHint);

  const listsWrapper = document.createElement("div");
  listsWrapper.className = "genre-insights__lists";

  const topColumn = document.createElement("section");
  topColumn.className = "genre-insights__column";
  const topHeading = document.createElement("h3");
  topHeading.textContent = "Top genres";
  const topList = document.createElement("ul");
  topList.className = "genre-insights__items";
  topColumn.appendChild(topHeading);
  topColumn.appendChild(topList);

  const bottomColumn = document.createElement("section");
  bottomColumn.className = "genre-insights__column";
  const bottomHeading = document.createElement("h3");
  bottomHeading.textContent = "Genres to diversify";
  const bottomList = document.createElement("ul");
  bottomList.className = "genre-insights__items";
  bottomColumn.appendChild(bottomHeading);
  bottomColumn.appendChild(bottomList);

  listsWrapper.appendChild(topColumn);
  listsWrapper.appendChild(bottomColumn);

  canvas.appendChild(controls);
  canvas.appendChild(listsWrapper);

  function bucketHasData(bucketKey) {
    if (bucketKey === "total") {
      return genres.some((entry) => (entry?.total?.weight ?? 0) > 0);
    }
    const summaryEntry = bucketSummaries[bucketKey];
    if (Number(summaryEntry?.total_weight ?? 0) > 0) {
      return true;
    }
    return genres.some(
      (entry) => (entry?.buckets?.[bucketKey]?.weight ?? 0) > 0
    );
  }

  function getBucketHint(bucketKey) {
    if (bucketKey === "total") {
      const totalTracked = Object.values(bucketSummaries).reduce(
        (acc, entry) => acc + (entry?.total_games ?? 0),
        0
      );
      if (totalTracked > 0) {
        const suffix = totalTracked === 1 ? "tracked title" : "tracked titles";
        return `All statuses: ${totalTracked.toLocaleString()} ${suffix} across every list.`;
      }
      return "All statuses: add more games to see aggregate genre trends.";
    }
    const label = resolveBucketLabel(bucketKey, bucketMetadata);
    const summaryEntry = bucketSummaries[bucketKey];
    if (summaryEntry?.total_games) {
      const suffix = summaryEntry.total_games === 1 ? "title" : "titles";
      return `${label}: ${summaryEntry.total_games.toLocaleString()} ${suffix} tagged with genres.`;
    }
    const description = resolveBucketDescription(bucketKey, bucketMetadata);
    return description || `No ${label.toLowerCase()} entries logged yet.`;
  }

  function renderList(target, entries, metric, isBottom = false) {
    target.innerHTML = "";
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    entries.forEach(({ entry, source, value }) => {
      const item = document.createElement("li");
      item.className = "genre-insights__item";

      const header = document.createElement("div");
      header.className = "genre-insights__item-header";

      const name = document.createElement("span");
      name.className = "genre-insights__item-name";
      name.textContent = entry.genre;

      const metricValue = document.createElement("span");
      metricValue.className = "genre-insights__item-value";
      if (isBottom) {
        metricValue.classList.add("genre-insights__item-value--low");
      }
      metricValue.textContent = metric.formatter(value, {
        entry,
        source,
        bucket: activeBucket,
      });

      header.appendChild(name);
      header.appendChild(metricValue);
      item.appendChild(header);

      const breakdown = document.createElement("div");
      breakdown.className = "genre-insights__item-breakdown";
      const highlightBucket =
        activeBucket === "total"
          ? entry.dominant === "balanced"
            ? null
            : entry.dominant
          : activeBucket;
      breakdown.innerHTML = buildGenreBreakdown(entry, {
        metadata: bucketMetadata,
        order: availableBuckets,
        highlight: highlightBucket,
      });
      item.appendChild(breakdown);

      const dominance = document.createElement("p");
      dominance.className = "genre-insights__item-dominance";
      const dominanceBucket = entry.dominant || "balanced";
      dominance.dataset.bucket = dominanceBucket;
      dominance.textContent = describeDominance(entry, bucketMetadata);
      if (dominanceBucket !== "balanced") {
        const color = getBucketColor(dominanceBucket, bucketMetadata);
        if (color) {
          dominance.style.setProperty("--dominance-color", color);
        }
      }
      item.appendChild(dominance);

      target.appendChild(item);
    });
  }

  function buildGenreBreakdown(entry, { metadata, order, highlight }) {
    const buckets = entry?.buckets || {};
    const contributions = Object.entries(buckets).filter(
      ([, metrics]) => metrics && Number(metrics.weight ?? 0) > 0
    );
    if (contributions.length === 0) {
      return '<span class="genre-insights__breakdown-empty">No genre breakdown yet.</span>';
    }

    contributions.sort((a, b) => {
      const aWeight = Number.isFinite(a[1].weight) ? a[1].weight : 0;
      const bWeight = Number.isFinite(b[1].weight) ? b[1].weight : 0;
      if (Math.abs(bWeight - aWeight) > 1e-6) {
        return bWeight - aWeight;
      }
      return getBucketOrderIndex(a[0], order) - getBucketOrderIndex(b[0], order);
    });

    const highlightBucket =
      highlight && highlight !== "balanced" ? highlight : null;

    let topContributions = contributions.slice(0, 3);
    if (highlightBucket) {
      const highlightEntry = contributions.find(
        ([bucket]) => bucket === highlightBucket
      );
      if (highlightEntry) {
        topContributions = [
          highlightEntry,
          ...topContributions.filter(([bucket]) => bucket !== highlightBucket),
        ];
      }
    }

    const uniqueMap = new Map();
    topContributions.forEach(([bucket, metrics]) => {
      if (!uniqueMap.has(bucket)) {
        uniqueMap.set(bucket, metrics);
      }
    });

    let finalContributions = Array.from(uniqueMap.entries()).sort((a, b) => {
      const aWeight = Number.isFinite(a[1].weight) ? a[1].weight : 0;
      const bWeight = Number.isFinite(b[1].weight) ? b[1].weight : 0;
      if (Math.abs(bWeight - aWeight) > 1e-6) {
        return bWeight - aWeight;
      }
      return getBucketOrderIndex(a[0], order) - getBucketOrderIndex(b[0], order);
    });

    if (finalContributions.length > 3) {
      finalContributions = finalContributions.slice(0, 3);
    }

    if (
      highlightBucket &&
      !finalContributions.some(([bucket]) => bucket === highlightBucket)
    ) {
      const highlightEntry = contributions.find(
        ([bucket]) => bucket === highlightBucket
      );
      if (highlightEntry) {
        finalContributions[finalContributions.length - 1] = highlightEntry;
      }
    }

    const pieces = finalContributions.map(([bucket, metrics]) => {
      const label = resolveBucketLabel(bucket, metadata);
      const shareLabel = formatPercent(metrics.share);
      const averageLabel = formatAverageElo(metrics.average_elo);
      const classes = ["genre-insights__breakdown-item"];
      if (bucket === highlightBucket) {
        classes.push("is-highlighted");
      }
      const styles = [];
      const color = getBucketColor(bucket, metadata);
      if (color) {
        styles.push(`--breakdown-accent:${color}`);
        const accentBg = hexToRgba(color, 0.18) || hexToRgba(color, 0.12);
        if (accentBg) {
          styles.push(`--breakdown-accent-bg:${accentBg}`);
        }
      }
      const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";
      return `<span class="${classes.join(" ")}" data-bucket="${bucket}"${styleAttr}>${label}: ${shareLabel} • ${averageLabel}</span>`;
    });

    const extraCount = contributions.length - finalContributions.length;
    if (extraCount > 0) {
      const suffix = extraCount === 1 ? "list" : "lists";
      pieces.push(
        `<span class="genre-insights__breakdown-more">+${extraCount} more ${suffix}</span>`
      );
    }

    return pieces.join(" ");
  }

  function updateLists() {
    bucketHint.textContent = getBucketHint(activeBucket);

    const decorated = genres.map((entry) => {
      const source =
        activeBucket === "total"
          ? entry.total
          : entry?.buckets?.[activeBucket];
      const value = activeMetric.extractor(source);
      return { entry, source, value };
    });

    const filtered = decorated.filter(({ source, value }) => {
      if (!source) return false;
      if (activeMetric.key === "average_elo") {
        return Number.isFinite(value);
      }
      if (activeMetric.key === "count") {
        return Number.isFinite(value) && value > 0;
      }
      const weight = source.weight ?? 0;
      return Number.isFinite(value) && weight > 0;
    });

    if (filtered.length === 0) {
      const emptyMessage =
        activeBucket === "total"
          ? "Not enough data to rank genres yet."
          : `No ${resolveBucketLabel(
              activeBucket,
              bucketMetadata
            )} data available yet.`;
      topList.innerHTML = `<li class="genre-insights__empty">${emptyMessage}</li>`;
      bottomList.innerHTML = "";
      return;
    }

    filtered.sort((a, b) => {
      const aValue = Number.isFinite(a.value) ? a.value : -Infinity;
      const bValue = Number.isFinite(b.value) ? b.value : -Infinity;
      return bValue - aValue;
    });

    const topItems = filtered.slice(0, 5);
    const bottomItems = filtered.slice(-5).reverse();

    renderList(topList, topItems, activeMetric);
    renderList(bottomList, bottomItems, activeMetric, true);
  }

  updateLists();
}
function renderGenreSentimentComparison(root, summary) {
  const sentimentChart = root.querySelector('[data-insights-chart="genre-sentiment"]');
  if (!sentimentChart) return;

  const canvas = sentimentChart.querySelector(".insights-chart__canvas");
  if (!canvas) return;

  canvas.innerHTML = "";
  canvas.dataset.state = "loaded";

  const genres = Array.isArray(summary?.genres) ? summary.genres : [];
  if (genres.length === 0) {
    canvas.innerHTML =
      '<p class="genre-sentiment__empty">Add more tracked sessions to compare hype and enjoyment by genre.</p>';
    return;
  }

  const bucketMetadata = state?.insightBuckets?.metadata || {};
  const bucketOrder = state?.insightBuckets?.order || [];

  const list = document.createElement("ul");
  list.className = "genre-sentiment__list";

  const clamp = (value) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

  genres.forEach((entry) => {
    const item = document.createElement("li");
    item.className = "genre-sentiment__item";

    const header = document.createElement("header");
    header.className = "genre-sentiment__header";

    const name = document.createElement("h3");
    name.textContent = entry.genre || "Unknown";
    header.appendChild(name);

    const playtimeLabel = document.createElement("span");
    playtimeLabel.className = "genre-sentiment__meta";
    const totalMinutes = entry?.sentiment?.total_playtime_minutes ?? 0;
    playtimeLabel.textContent = `${formatPlaytimeMinutes(totalMinutes)} played`;
    header.appendChild(playtimeLabel);

    item.appendChild(header);

    const interestScore = entry?.interest?.interest_score;
    const enjoymentScore = entry?.sentiment?.weighted_sentiment;

    const bars = document.createElement("div");
    bars.className = "genre-sentiment__bars";

    const buildBar = (label, value, type) => {
      const wrapper = document.createElement("div");
      wrapper.className = `genre-sentiment__bar genre-sentiment__bar--${type}`;

      const fill = document.createElement("div");
      fill.className = `genre-sentiment__fill genre-sentiment__fill--${type}`;
      if (Number.isFinite(value)) {
        fill.style.setProperty("--fill-width", `${clamp(value)}%`);
        fill.innerHTML = `<span>${label} ${formatScorePoints(value)}</span>`;
      } else {
        fill.classList.add("is-empty");
        fill.innerHTML = `<span>${label} —</span>`;
      }

      wrapper.appendChild(fill);
      return wrapper;
    };

    bars.appendChild(buildBar("Interest", interestScore, "interest"));
    bars.appendChild(buildBar("Enjoyment", enjoymentScore, "enjoyment"));
    item.appendChild(bars);

    const gap = document.createElement("p");
    gap.className = "genre-sentiment__gap";
    if (Number.isFinite(interestScore) && Number.isFinite(enjoymentScore)) {
      const delta = interestScore - enjoymentScore;
      const magnitude = Math.round(Math.abs(delta));
      if (delta >= 8) {
        gap.textContent = `Hype outpaces enjoyment by ${magnitude} pt${
          magnitude === 1 ? "" : "s"
        }.`;
        gap.classList.add("genre-sentiment__gap--warning");
      } else if (delta <= -8) {
        gap.textContent = `Enjoyment is surpassing expectations by ${magnitude} pt${
          magnitude === 1 ? "" : "s"
        }.`;
        gap.classList.add("genre-sentiment__gap--positive");
      } else {
        gap.textContent = "Hype and enjoyment are closely aligned.";
      }
    } else {
      gap.textContent = "More data is needed to compare hype and enjoyment.";
    }
    item.appendChild(gap);

    const statuses = entry?.sentiment?.statuses ?? {};
    const statusEntries = Object.entries(statuses).filter(([, metrics]) => {
      const playtime = Number(metrics?.total_playtime_minutes ?? 0);
      const score = metrics?.weighted_sentiment;
      return Number.isFinite(score) || playtime > 0;
    });
    const statusLabel = document.createElement("p");
    statusLabel.className = "genre-sentiment__status";
    if (statusEntries.length === 0) {
      statusLabel.textContent = "No status-specific sentiment available yet.";
    } else {
      statusEntries.sort(
        (a, b) =>
          getBucketOrderIndex(a[0], bucketOrder) -
          getBucketOrderIndex(b[0], bucketOrder)
      );
      statusLabel.innerHTML = statusEntries
        .map(([bucket, metrics]) => {
          const label = resolveBucketLabel(bucket, bucketMetadata);
          const playtime = formatPlaytimeMinutes(
            metrics?.total_playtime_minutes ?? 0
          );
          const score = formatScorePoints(metrics?.weighted_sentiment);
          const styles = [];
          const color = getBucketColor(bucket, bucketMetadata);
          if (color) {
            styles.push(`--status-accent:${color}`);
            const accentBg = hexToRgba(color, 0.18) || hexToRgba(color, 0.12);
            if (accentBg) {
              styles.push(`--status-accent-bg:${accentBg}`);
            }
          }
          const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";
          return `<span class="genre-sentiment__status-chip"${styleAttr}>${label}: ${playtime} • ${score}</span>`;
        })
        .join(" ");
    }
    item.appendChild(statusLabel);

    list.appendChild(item);
  });

  canvas.appendChild(list);
}

function renderLifecycleSummary(root, summary) {
  if (!root) return;

  const purchaseToStart = summary?.purchase_to_start ?? {};
  const startToFinish = summary?.start_to_finish ?? {};
  const purchaseToFinish = summary?.purchase_to_finish ?? {};
  const agingBacklog = Array.isArray(summary?.aging_backlog)
    ? summary.aging_backlog
    : [];

  const purchaseStats = purchaseToStart.statistics ?? {};
  const startStats = startToFinish.statistics ?? {};
  const purchaseFinishStats = purchaseToFinish.statistics ?? {};
  const purchasePercentiles = purchaseStats.percentiles ?? {};
  const startPercentiles = startStats.percentiles ?? {};

  const avgToStartValue =
    (purchaseStats.count ?? 0) > 0 ? formatDays(purchaseStats.mean ?? NaN) : null;
  const avgToFinishValue =
    (startStats.count ?? 0) > 0 ? formatDays(startStats.mean ?? NaN) : null;
  const avgPurchaseToFinishValue =
    (purchaseFinishStats.count ?? 0) > 0
      ? formatDays(purchaseFinishStats.mean ?? NaN)
      : null;

  updateMetricValue(
    root.querySelector('[data-lifecycle-metric="avg-to-start"] .insights-card__value'),
    avgToStartValue
  );
  updateMetricValue(
    root.querySelector('[data-lifecycle-metric="avg-to-finish"] .insights-card__value'),
    avgToFinishValue
  );
  updateMetricValue(
    root.querySelector(
      '[data-lifecycle-metric="avg-purchase-to-finish"] .insights-card__value'
    ),
    avgPurchaseToFinishValue
  );

  const medianToStart =
    (purchaseStats.count ?? 0) > 0 ? formatDays(purchaseStats.median ?? NaN, { decimals: 0 }) : null;
  const p75ToStart = Number.isFinite(purchasePercentiles.p75)
    ? formatDays(purchasePercentiles.p75, { decimals: 0 })
    : null;
  const medianToFinish =
    (startStats.count ?? 0) > 0 ? formatDays(startStats.median ?? NaN, { decimals: 0 }) : null;

  updateMetricValue(
    root.querySelector('[data-lifecycle-highlight="median-to-start"] .insights-card__value'),
    medianToStart
  );
  updateMetricValue(
    root.querySelector('[data-lifecycle-highlight="p75-to-start"] .insights-card__value'),
    p75ToStart
  );
  updateMetricValue(
    root.querySelector('[data-lifecycle-highlight="median-to-finish"] .insights-card__value'),
    medianToFinish
  );

  const durationsContainer = root.querySelector(
    '[data-lifecycle-table="durations"] .insights-table__content'
  );
  if (durationsContainer) {
    durationsContainer.innerHTML = "";

    const stages = [
      {
        key: "purchase_to_start",
        label: "Purchase → Start",
        stats: purchaseStats,
        percentiles: purchasePercentiles,
        examples: Array.isArray(purchaseToStart.longest_examples)
          ? purchaseToStart.longest_examples
          : [],
      },
      {
        key: "start_to_finish",
        label: "Start → Finish",
        stats: startStats,
        percentiles: startPercentiles,
        examples: Array.isArray(startToFinish.longest_examples)
          ? startToFinish.longest_examples
          : [],
      },
      {
        key: "purchase_to_finish",
        label: "Purchase → Finish",
        stats: purchaseFinishStats,
        percentiles: purchaseFinishStats.percentiles ?? {},
        examples: Array.isArray(purchaseToFinish.longest_examples)
          ? purchaseToFinish.longest_examples
          : [],
      },
    ];

    const hasSamples = stages.some((stage) => (stage.stats?.count ?? 0) > 0);
    if (!hasSamples) {
      const empty = document.createElement("p");
      empty.className = "insights-table__empty";
      empty.textContent = "Lifecycle metrics will appear once games have timeline data.";
      durationsContainer.appendChild(empty);
    } else {
      const table = document.createElement("table");
      table.className = "insights-table__grid";

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      [
        "Stage",
        "Median",
        "Typical range (25–75%)",
        "90th percentile",
        "Longest observed",
        "Samples",
      ].forEach((heading) => {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = heading;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      stages.forEach((stage) => {
        const count = stage.stats?.count ?? 0;
        const percentiles = stage.percentiles ?? {};
        const row = document.createElement("tr");

        const stageCell = document.createElement("th");
        stageCell.scope = "row";
        stageCell.textContent = stage.label;
        row.appendChild(stageCell);

        const medianCell = document.createElement("td");
        medianCell.textContent =
          count > 0 ? formatDays(stage.stats?.median ?? NaN, { decimals: 0 }) : "—";
        row.appendChild(medianCell);

        const rangeCell = document.createElement("td");
        rangeCell.textContent =
          count > 0 ? formatDaysRange(percentiles.p25, percentiles.p75) : "—";
        row.appendChild(rangeCell);

        const p90Cell = document.createElement("td");
        p90Cell.textContent = Number.isFinite(percentiles.p90)
          ? formatDays(percentiles.p90, { decimals: 0 })
          : "—";
        row.appendChild(p90Cell);

        const longestCell = document.createElement("td");
        const longestExample = Array.isArray(stage.examples) ? stage.examples[0] : null;
        if (longestExample && Number.isFinite(longestExample.days)) {
          longestCell.textContent = `${formatDays(longestExample.days, {
            decimals: 0,
          })} • ${longestExample.title}`;
        } else {
          longestCell.textContent = "—";
        }
        row.appendChild(longestCell);

        const samplesCell = document.createElement("td");
        samplesCell.textContent = count.toLocaleString();
        row.appendChild(samplesCell);

        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      durationsContainer.appendChild(table);
    }
  }

  const backlogContainer = root.querySelector(
    '[data-lifecycle-table="aging-backlog"] .insights-table__content'
  );
  if (backlogContainer) {
    backlogContainer.innerHTML = "";

    if (agingBacklog.length === 0) {
      const empty = document.createElement("p");
      empty.className = "insights-table__empty";
      empty.textContent = "No backlog entries are currently waiting on a start date.";
      backlogContainer.appendChild(empty);
    } else {
      const table = document.createElement("table");
      table.className = "insights-table__grid";

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      ["Title", "Days waiting", "Purchased", "Added to backlog"].forEach((heading) => {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = heading;
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      agingBacklog.forEach((entry) => {
        const row = document.createElement("tr");

        const titleCell = document.createElement("th");
        titleCell.scope = "row";
        titleCell.textContent = entry.title || "Untitled";
        row.appendChild(titleCell);

        const daysCell = document.createElement("td");
        const waitValue = Number.isFinite(entry.days_waiting)
          ? Math.max(entry.days_waiting, 0)
          : entry.days_waiting;
        daysCell.textContent = formatDays(waitValue, { decimals: 0 });
        row.appendChild(daysCell);

        const purchaseCell = document.createElement("td");
        purchaseCell.textContent = formatDateForDisplay(entry.purchase_date);
        row.appendChild(purchaseCell);

        const addedCell = document.createElement("td");
        addedCell.textContent = formatDateForDisplay(entry.added_date);
        row.appendChild(addedCell);

        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      backlogContainer.appendChild(table);
    }
  }
}

async function initInsightsPage() {
  const root = document.querySelector("[data-insights-root]");
  if (!root) return;

  const placeholders = root.querySelectorAll("[data-placeholder-text]");
  placeholders.forEach((element) => {
    if (!element.textContent.trim()) {
      element.textContent = element.dataset.placeholderText;
    }
  });

  root.dataset.state = "loading";

  try {
    const [summary, sentimentSummary, lifecycleSummary, engagementSummary] =
      await Promise.all([
        fetchJSON("/api/insights/genres"),
        fetchJSON("/api/insights/genre-sentiment"),
        fetchJSON("/api/insights/lifecycle"),
        fetchJSON("/api/insights/engagement-trend"),
      ]);

    state.insightBuckets = {
      metadata: summary?.bucket_metadata || {},
      order: summary?.bucket_order || [],
      summaries: summary?.buckets || {},
    };

    const bucketSummaries = summary?.buckets || {};

    const backlogMetric = root.querySelector(
      '[data-insights-metric="backlog"] .insights-card__value'
    );
    const backlogSummary = bucketSummaries.backlog;
    if (backlogMetric && backlogSummary) {
      const totalGames = backlogSummary.total_games ?? 0;
      backlogMetric.textContent = `${totalGames.toLocaleString()} game${
        totalGames === 1 ? "" : "s"
      }`;
    }

    const wishlistMetric = root.querySelector(
      '[data-insights-metric="wishlist"] .insights-card__value'
    );
    const wishlistSummary = bucketSummaries.wishlist;
    if (wishlistMetric && wishlistSummary) {
      const totalGames = wishlistSummary.total_games ?? 0;
      wishlistMetric.textContent = `${totalGames.toLocaleString()} title${
        totalGames === 1 ? "" : "s"
      }`;
    }

    const playtimeMetric = root.querySelector(
      '[data-insights-metric="playtime"] .insights-card__value'
    );
    if (playtimeMetric && engagementSummary?.timeline?.length) {
      const latest = engagementSummary.timeline[engagementSummary.timeline.length - 1];
      playtimeMetric.textContent = `${formatPlaytimeMinutes(
        latest.total_minutes || 0
      )} · mood ${formatSentimentValue(latest.average_sentiment)}`;
    }

    renderEngagementTrend(root, engagementSummary);
    renderEngagementCallouts(root, engagementSummary);
    renderGenreInsights(root, summary);
    renderGenreSentimentComparison(root, sentimentSummary);
    renderLifecycleSummary(root, lifecycleSummary);
    root.dataset.state = "loaded";
  } catch (error) {
    console.error("Failed to load insight data", error);
    const engagementChart = root.querySelector(
      '[data-insights-chart="engagement"] .insights-chart__canvas'
    );
    if (engagementChart) {
      engagementChart.innerHTML =
        '<p class="engagement-chart__error">Unable to load engagement trend right now.</p>';
    }
    const calloutContainer = root.querySelector('[data-insights-callouts]');
    if (calloutContainer) {
      calloutContainer.innerHTML =
        '<p class="insights-callouts__error">Unable to load engagement highlights right now.</p>';
    }
    const genreChart = root.querySelector('[data-insights-chart="genre"] .insights-chart__canvas');
    if (genreChart) {
      genreChart.innerHTML =
        '<p class="genre-insights__error">Unable to load genre insights right now. Please try again later.</p>';
    }
    const sentimentChart = root.querySelector(
      '[data-insights-chart="genre-sentiment"] .insights-chart__canvas'
    );
    if (sentimentChart) {
      sentimentChart.innerHTML =
        '<p class="genre-insights__error">Unable to load genre sentiment right now. Please try again later.</p>';
    }
    const lifecycleSections = root.querySelectorAll(
      '[data-lifecycle-table] .insights-table__content'
    );
    lifecycleSections.forEach((section) => {
      const errorMessage = document.createElement("p");
      errorMessage.className = "insights-table__error";
      errorMessage.textContent = "Unable to load lifecycle analytics right now.";
      section.innerHTML = "";
      section.appendChild(errorMessage);
    });
    root.dataset.state = "error";
  }
}

function createGameCard(game, { onDelete, onUpdate } = {}) {
  const li = document.createElement("li");
  li.className = "game-card";

  const header = document.createElement("div");
  header.className = "game-card-header";

  if (game.icon_url) {
    const art = document.createElement("img");
    art.src = game.icon_url;
    art.alt = `${game.title} artwork`;
    art.loading = "lazy";
    art.className = "game-card-art";
    header.appendChild(art);
  }

  const headerContent = document.createElement("div");
  headerContent.className = "game-card-header-content";

  const title = document.createElement("h4");
  const detailLink = document.createElement("a");
  detailLink.href = `/games/${game.id}`;
  detailLink.className = "game-card-title-link";
  detailLink.textContent = game.title;
  title.appendChild(detailLink);
  headerContent.appendChild(title);

  const statusBadge = document.createElement("span");
  statusBadge.className = `game-card-status game-card-status--${game.status}`;
  statusBadge.textContent = getStatusLabel(game.status);
  headerContent.appendChild(statusBadge);

  header.appendChild(headerContent);
  li.appendChild(header);

  const rating = document.createElement("div");
  rating.className = "meta";
  rating.textContent = `ELO: ${Math.round(game.elo_rating)}`;
  li.appendChild(rating);

  if (Array.isArray(game.modes) && game.modes.length > 0) {
    const modes = document.createElement("div");
    modes.className = "tag-list";
    modes.innerHTML = buildTagElements(game.modes);
    li.appendChild(modes);
  }

  if (Array.isArray(game.genres) && game.genres.length > 0) {
    const genres = document.createElement("div");
    genres.className = "tag-list";
    genres.innerHTML = buildTagElements(game.genres);
    li.appendChild(genres);
  }

  const timelineRows = [];
  if (game.purchase_date) {
    timelineRows.push(`<strong>Purchased:</strong> ${formatDateForDisplay(game.purchase_date)}`);
  }
  if (game.start_date) {
    timelineRows.push(`<strong>Started:</strong> ${formatDateForDisplay(game.start_date)}`);
  }
  if (game.finish_date) {
    timelineRows.push(`<strong>Finished:</strong> ${formatDateForDisplay(game.finish_date)}`);
  }
  if (timelineRows.length > 0) {
    const timeline = document.createElement("div");
    timeline.className = "meta meta-timeline";
    timeline.innerHTML = timelineRows.join("<br />");
    li.appendChild(timeline);
  }

  if (game.thoughts) {
    const thoughts = document.createElement("p");
    thoughts.className = "game-card-thoughts";
    thoughts.textContent = game.thoughts;
    li.appendChild(thoughts);
  }

  const actions = document.createElement("div");
  actions.className = "game-card-actions";
  if (game.steam_app_id) {
    const link = document.createElement("a");
    link.href = `https://store.steampowered.com/app/${game.steam_app_id}/`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Steam";
    actions.appendChild(link);
  }

  const editForm = document.createElement("form");
  editForm.className = "game-edit-form hidden";

  const editFields = document.createElement("div");
  editFields.className = "game-edit-grid";

  function buildField(labelText, inputElement) {
    const wrapper = document.createElement("label");
    wrapper.className = "game-edit-field";
    const caption = document.createElement("span");
    caption.className = "game-edit-label";
    caption.textContent = labelText;
    wrapper.appendChild(caption);
    wrapper.appendChild(inputElement);
    return wrapper;
  }

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.name = "title";
  titleInput.required = true;
  titleInput.value = game.title;
  editFields.appendChild(buildField("Title", titleInput));

  const statusSelect = document.createElement("select");
  statusSelect.name = "status";
  STATUS_TAXONOMY.forEach(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    statusSelect.appendChild(option);
  });
  statusSelect.value = game.status;
  editFields.appendChild(buildField("List", statusSelect));

  const purchaseInput = document.createElement("input");
  purchaseInput.type = "date";
  purchaseInput.name = "purchase_date";
  if (game.purchase_date) {
    purchaseInput.value = game.purchase_date;
  }
  const purchaseField = buildField("Purchase date", purchaseInput);
  purchaseField.dataset.editPurchase = "";
  const purchaseHint = document.createElement("small");
  purchaseHint.className = "game-edit-hint";
  purchaseHint.textContent = "Required once you've purchased the game.";
  purchaseField.appendChild(purchaseHint);
  editFields.appendChild(purchaseField);

  const startInput = document.createElement("input");
  startInput.type = "date";
  startInput.name = "start_date";
  if (game.start_date) {
    startInput.value = game.start_date;
  }
  editFields.appendChild(buildField("Started", startInput));

  const finishInput = document.createElement("input");
  finishInput.type = "date";
  finishInput.name = "finish_date";
  if (game.finish_date) {
    finishInput.value = game.finish_date;
  }
  editFields.appendChild(buildField("Finished", finishInput));

  const thoughtsInput = document.createElement("textarea");
  thoughtsInput.name = "thoughts";
  thoughtsInput.rows = 3;
  thoughtsInput.value = game.thoughts || "";
  thoughtsInput.placeholder = "Notes, vibes, wishlisted reasons...";
  editFields.appendChild(buildField("Thoughts", thoughtsInput));

  editForm.appendChild(editFields);

  const editMessage = document.createElement("p");
  editMessage.className = "hint game-edit-message";
  editForm.appendChild(editMessage);

  const editButtons = document.createElement("div");
  editButtons.className = "game-edit-actions";
  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Save";
  editButtons.appendChild(saveButton);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "secondary";
  cancelButton.textContent = "Cancel";
  editButtons.appendChild(cancelButton);
  editForm.appendChild(editButtons);

  function updateEditPurchaseRequirement() {
    const requiresPurchase = statusRequiresPurchase(statusSelect.value);
    purchaseInput.required = requiresPurchase;
    purchaseField.classList.toggle("is-optional", !requiresPurchase);
    if (requiresPurchase) {
      applyDefaultDateIfEmpty(purchaseInput);
    } else {
      purchaseInput.value = "";
    }
  }

  function resetEditForm() {
    titleInput.value = game.title;
    statusSelect.value = game.status;
    purchaseInput.value = game.purchase_date || "";
    startInput.value = game.start_date || "";
    finishInput.value = game.finish_date || "";
    thoughtsInput.value = game.thoughts || "";
    editMessage.textContent = "";
    updateEditPurchaseRequirement();
  }

  statusSelect.addEventListener("change", () => {
    const wasRequired = purchaseInput.required;
    updateEditPurchaseRequirement();
    if (!wasRequired && purchaseInput.required && !purchaseInput.value) {
      applyDefaultDateIfEmpty(purchaseInput);
    }
  });

  cancelButton.addEventListener("click", () => {
    resetEditForm();
    editForm.classList.add("hidden");
  });

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => {
    resetEditForm();
    editForm.classList.toggle("hidden");
    if (!editForm.classList.contains("hidden")) {
      titleInput.focus();
    }
  });
  actions.appendChild(editButton);

  if (typeof onDelete === "function") {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Remove";
    deleteBtn.style.background = "#ff5d5d";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete ${game.title}?`)) return;
      try {
        await fetchJSON(`/api/games/${game.id}`, { method: "DELETE" });
        await onDelete();
      } catch (error) {
        alert(error.message);
      }
    });
    actions.appendChild(deleteBtn);
  }

  if (actions.children.length > 0) {
    li.appendChild(actions);
  }

  let saving = false;

  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const trimmedThoughts = thoughtsInput.value.trim();
    const payload = {
      title: titleInput.value.trim(),
      status: statusSelect.value,
      purchase_date: purchaseInput.value ? purchaseInput.value : null,
      start_date: startInput.value ? startInput.value : null,
      finish_date: finishInput.value ? finishInput.value : null,
      thoughts: trimmedThoughts ? trimmedThoughts : null,
    };

    if (!payload.title) {
      editMessage.textContent = "Title is required.";
      titleInput.focus();
      return;
    }

    if (!statusRequiresPurchase(payload.status)) {
      payload.purchase_date = null;
    } else if (!payload.purchase_date) {
      editMessage.textContent =
        "Purchase date is required once you've purchased the game.";
      purchaseInput.focus();
      return;
    }

    saving = true;
    saveButton.disabled = true;
    cancelButton.disabled = true;
    editMessage.textContent = "Saving...";

    try {
      const updatedGame = await fetchJSON(`/api/games/${game.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      editMessage.textContent = "Game updated.";
      editForm.classList.add("hidden");
      if (typeof onUpdate === "function") {
        await onUpdate(updatedGame);
      }
    } catch (error) {
      editMessage.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
      saveButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  updateEditPurchaseRequirement();

  li.appendChild(editForm);

  return li;
}

function applyDefaultDateIfEmpty(input) {
  if (!input) return;
  if (!input.value) {
    input.value = new Date().toISOString().split("T")[0];
  }
}

async function initAddGamePage() {
  const form = document.getElementById("add-game-form");
  if (!form) return;

  const titleInput = document.getElementById("title");
  const statusSelect = document.getElementById("status");
  const purchaseInput = document.getElementById("purchase-date");
  const purchaseGroup = form.querySelector("[data-purchase-group]");
  const startInput = document.getElementById("start-date");
  const finishInput = document.getElementById("finish-date");
  const thoughtsInput = document.getElementById("thoughts");
  const steamAppIdInput = document.getElementById("steam-app-id");
  const steamAppIdStatus = document.getElementById("steam-app-id-status");
  const detectedGenresContainer = document.getElementById("detected-genres");
  const detectedGenresHint = document.getElementById("detected-genres-hint");
  const iconPreview = document.getElementById("icon-preview");
  const message = document.getElementById("game-form-message");

  let titleAutofilled = false;
  let steamLookupTimeout;
  let steamLookupToken = 0;

  const defaultSteamStatusMessage =
    (steamAppIdStatus?.textContent || "").trim() ||
    "Add an App ID to fetch genres and artwork.";
  const defaultGenresHintMessage =
    (detectedGenresHint?.textContent || "").trim() ||
    "Genres will appear after fetching from Steam.";
  const defaultArtworkMessage =
    (iconPreview?.dataset.defaultMessage || "").trim() ||
    "Artwork will appear after fetching from Steam.";

  function updatePurchaseRequirement() {
    if (!statusSelect || !purchaseInput) return;
    const requiresPurchase = statusRequiresPurchase(statusSelect.value);
    purchaseInput.required = requiresPurchase;
    if (purchaseGroup) {
      purchaseGroup.classList.toggle("is-optional", !requiresPurchase);
    }
    if (requiresPurchase) {
      applyDefaultDateIfEmpty(purchaseInput);
    } else {
      purchaseInput.value = "";
    }
  }

  function clearSteamMetadataPreview(messageText) {
    if (detectedGenresContainer) {
      detectedGenresContainer.innerHTML = "";
    }
    if (detectedGenresHint) {
      detectedGenresHint.textContent = messageText || defaultGenresHintMessage;
      detectedGenresHint.classList.remove("hidden");
    }
    if (iconPreview) {
      iconPreview.innerHTML = "";
      iconPreview.textContent = defaultArtworkMessage;
      iconPreview.classList.remove("has-art");
    }
  }

  function renderSteamMetadataPreview(genres = [], iconUrl = null) {
    if (detectedGenresContainer) {
      detectedGenresContainer.innerHTML = genres.length
        ? buildTagElements(genres)
        : "";
    }

    if (detectedGenresHint) {
      if (genres.length > 0) {
        detectedGenresHint.classList.add("hidden");
      } else {
        detectedGenresHint.textContent = "Steam did not provide genre details.";
        detectedGenresHint.classList.remove("hidden");
      }
    }

    if (iconPreview) {
      iconPreview.innerHTML = "";
      if (iconUrl) {
        const img = document.createElement("img");
        img.src = iconUrl;
        img.alt = "Steam artwork";
        img.loading = "lazy";
        iconPreview.appendChild(img);
        iconPreview.classList.add("has-art");
      } else {
        iconPreview.textContent = defaultArtworkMessage;
        iconPreview.classList.remove("has-art");
      }
    }
  }

  function clearTitleAutofill() {
    titleAutofilled = false;
  }

  function applyTitleAutofill(value) {
    if (!titleInput) return;
    const trimmed = (value || "").trim();
    if (!trimmed) return;
    if (!titleInput.value.trim() || titleAutofilled) {
      titleInput.value = trimmed;
      titleAutofilled = true;
    }
  }

  async function lookupSteamMetadata(appId) {
    const token = ++steamLookupToken;
    if (steamAppIdStatus) {
      steamAppIdStatus.textContent = "Fetching Steam details...";
    }

    try {
      const payload = await fetchJSON(`/api/steam/${appId}`);
      if (token !== steamLookupToken) {
        return;
      }

      const entry = payload?.[appId] || payload;
      if (!entry || entry.success === false || !entry.data) {
        throw new Error("No details found for that App ID.");
      }

      const data = entry.data;
      applyTitleAutofill(data?.name);
      const genres = Array.isArray(data.genres)
        ? data.genres
            .map((genre) => genre?.description)
            .filter((value) => typeof value === "string" && value.trim())
            .map((value) => value.trim())
        : [];

      let iconUrl =
        data.header_image || data.capsule_image || data.capsule_imagev5 || "";
      if (!iconUrl && data.img_icon_url) {
        const resolvedId = data.steam_appid || appId;
        iconUrl = `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${resolvedId}/${data.img_icon_url}.jpg`;
      }

      renderSteamMetadataPreview(genres, iconUrl || null);

      if (steamAppIdStatus) {
        steamAppIdStatus.textContent = genres.length
          ? "Steam details loaded."
          : "Steam details loaded but no genres were provided.";
      }
    } catch (error) {
      if (token !== steamLookupToken) {
        return;
      }
      clearSteamMetadataPreview(error instanceof Error ? error.message : String(error));
      if (steamAppIdStatus) {
        steamAppIdStatus.textContent =
          error instanceof Error ? error.message : String(error);
      }
    }
  }

  function scheduleSteamLookup() {
    if (!steamAppIdInput) return;
    const value = steamAppIdInput.value.trim();
    clearTimeout(steamLookupTimeout);

    if (!value) {
      steamLookupToken += 1;
      clearSteamMetadataPreview();
      if (steamAppIdStatus) {
        steamAppIdStatus.textContent = defaultSteamStatusMessage;
      }
      return;
    }

    steamLookupTimeout = setTimeout(() => {
      lookupSteamMetadata(value).catch((error) => {
        console.error(error);
      });
    }, 500);
  }

  statusSelect?.addEventListener("change", updatePurchaseRequirement);
  steamAppIdInput?.addEventListener("input", scheduleSteamLookup);
  steamAppIdInput?.addEventListener("blur", () => {
    if (!steamAppIdInput.value.trim()) {
      clearSteamMetadataPreview();
      if (steamAppIdStatus) {
        steamAppIdStatus.textContent = defaultSteamStatusMessage;
      }
    }
  });
  titleInput?.addEventListener("input", clearTitleAutofill);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!statusSelect) return;

    const formData = new FormData(form);
    const payload = {
      title: formData.get("title"),
      status: formData.get("status"),
      steam_app_id: formData.get("steam_app_id"),
      purchase_date: formData.get("purchase_date"),
      start_date: formData.get("start_date"),
      finish_date: formData.get("finish_date"),
      thoughts: formData.get("thoughts"),
      modes: Array.from(form.querySelectorAll(".mode-option:checked")).map((input) =>
        input.value.trim()
      ),
    };

    payload.title = String(payload.title || "").trim();
    payload.status = String(payload.status || DEFAULT_STATUS).trim().toLowerCase();
    payload.steam_app_id = String(payload.steam_app_id || "").trim();
    payload.thoughts = String(payload.thoughts || "").trim();
    payload.purchase_date = String(payload.purchase_date || "").trim();
    payload.start_date = String(payload.start_date || "").trim();
    payload.finish_date = String(payload.finish_date || "").trim();

    if (!payload.title) {
      message.textContent = "Title is required.";
      return;
    }

    if (statusRequiresPurchase(payload.status) && !payload.purchase_date) {
      message.textContent = "Purchase date is required once you've purchased the game.";
      return;
    }

    if (!payload.steam_app_id) {
      delete payload.steam_app_id;
    }
    if (!payload.thoughts) {
      delete payload.thoughts;
    }
    if (!payload.purchase_date) {
      delete payload.purchase_date;
    }
    if (!payload.start_date) {
      delete payload.start_date;
    }
    if (!payload.finish_date) {
      delete payload.finish_date;
    }

    try {
      await fetchJSON("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      message.textContent = "Game added.";
      form.reset();
      clearTitleAutofill();
      clearSteamMetadataPreview();
      if (steamAppIdStatus) {
        steamAppIdStatus.textContent = defaultSteamStatusMessage;
      }
      if (thoughtsInput) {
        thoughtsInput.value = "";
      }
      await fetchAndCacheGames({ force: true });
      updatePurchaseRequirement();
      if (purchaseInput) {
        if (statusRequiresPurchase(statusSelect.value)) {
          applyDefaultDateIfEmpty(purchaseInput);
        } else {
          purchaseInput.value = "";
        }
      }
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  updatePurchaseRequirement();
  clearSteamMetadataPreview();
}

async function initGameDetailPage() {
  const container = document.getElementById("game-detail");
  if (!container) return;

  const gameId = Number(container.dataset.gameId || "");
  if (!Number.isFinite(gameId) || gameId <= 0) {
    return;
  }

  const editToggle = document.getElementById("game-edit-toggle");
  const editForm = document.getElementById("game-edit-form");
  const editMessage = document.getElementById("game-edit-message");
  const editCancel = document.getElementById("game-edit-cancel");
  const deleteButton = document.getElementById("game-delete-button");
  const titleInput = document.getElementById("game-edit-title");
  const statusSelect = document.getElementById("game-edit-status");
  const purchaseInput = document.getElementById("game-edit-purchase-date");
  const purchaseField = document.getElementById("game-edit-purchase-field");
  const startInput = document.getElementById("game-edit-start-date");
  const finishInput = document.getElementById("game-edit-finish-date");
  const thoughtsInput = document.getElementById("game-edit-thoughts");
  const editSubmit = editForm?.querySelector('button[type="submit"]');

  const initialValues = {
    title: titleInput?.value || "",
    status: statusSelect?.value || DEFAULT_STATUS,
    purchase: purchaseInput?.value || "",
    start: startInput?.value || "",
    finish: finishInput?.value || "",
    thoughts: thoughtsInput?.value || "",
  };

  function updatePurchaseRequirement() {
    if (!statusSelect || !purchaseInput) return;
    const requiresPurchase = statusRequiresPurchase(statusSelect.value);
    purchaseInput.required = requiresPurchase;
    if (purchaseField) {
      purchaseField.classList.toggle("is-optional", !requiresPurchase);
    }
    if (!requiresPurchase) {
      purchaseInput.value = "";
    } else if (!purchaseInput.value) {
      applyDefaultDateIfEmpty(purchaseInput);
    }
  }

  function resetEditForm() {
    if (!editForm) return;
    if (titleInput) titleInput.value = initialValues.title;
    if (statusSelect) statusSelect.value = initialValues.status;
    if (purchaseInput) purchaseInput.value = initialValues.purchase;
    if (startInput) startInput.value = initialValues.start;
    if (finishInput) finishInput.value = initialValues.finish;
    if (thoughtsInput) thoughtsInput.value = initialValues.thoughts;
    if (editMessage) editMessage.textContent = "";
    updatePurchaseRequirement();
  }

  if (statusSelect) {
    statusSelect.addEventListener("change", () => {
      const wasRequired = purchaseInput?.required;
      updatePurchaseRequirement();
      if (purchaseInput && !purchaseInput.value && purchaseInput.required && !wasRequired) {
        applyDefaultDateIfEmpty(purchaseInput);
      }
    });
  }

  if (editToggle && editForm) {
    editToggle.addEventListener("click", () => {
      resetEditForm();
      editForm.classList.toggle("hidden");
      if (!editForm.classList.contains("hidden") && titleInput) {
        titleInput.focus();
      }
    });
  }

  if (editCancel && editForm) {
    editCancel.addEventListener("click", () => {
      resetEditForm();
      editForm.classList.add("hidden");
    });
  }

  if (deleteButton) {
    deleteButton.addEventListener("click", async () => {
      const confirmed = window.confirm("Delete this game? This cannot be undone.");
      if (!confirmed) return;
      deleteButton.disabled = true;
      try {
        await fetchJSON(`/api/games/${gameId}`, { method: "DELETE" });
        window.location.href = "/library";
      } catch (error) {
        deleteButton.disabled = false;
        alert(error instanceof Error ? error.message : String(error));
      }
    });
  }

  if (editForm) {
    editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!titleInput || !statusSelect || !editSubmit) return;

      const purchaseValue = purchaseInput?.value?.trim() || "";
      const startValue = startInput?.value?.trim() || "";
      const finishValue = finishInput?.value?.trim() || "";
      const thoughtsValue = thoughtsInput?.value?.trim() || "";

      const payload = {
        title: titleInput.value.trim(),
        status: statusSelect.value,
        purchase_date: purchaseValue || null,
        start_date: startValue || null,
        finish_date: finishValue || null,
        thoughts: thoughtsValue || null,
      };

      if (!payload.title) {
        if (editMessage) editMessage.textContent = "Title is required.";
        titleInput.focus();
        return;
      }

      if (!statusRequiresPurchase(payload.status)) {
        payload.purchase_date = null;
      } else if (!payload.purchase_date) {
        if (editMessage) {
          editMessage.textContent =
            "Purchase date is required once you've purchased the game.";
        }
        purchaseInput?.focus();
        return;
      }

      editSubmit.disabled = true;
      if (editCancel) editCancel.disabled = true;
      if (editMessage) editMessage.textContent = "Saving changes...";

      try {
        await fetchJSON(`/api/games/${gameId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (editMessage) editMessage.textContent = "Game updated. Refreshing...";
        setTimeout(() => {
          window.location.reload();
        }, 600);
      } catch (error) {
        if (editMessage) {
          editMessage.textContent = error instanceof Error ? error.message : String(error);
        }
        editSubmit.disabled = false;
        if (editCancel) editCancel.disabled = false;
      }
    });
  }

  updatePurchaseRequirement();

  const sessionForm = document.getElementById("game-session-form");
  const sessionMessage = document.getElementById("game-session-message");
  const sessionDateInput = document.getElementById("game-session-date");
  const sessionPlaytimeInput = document.getElementById("game-session-playtime");
  const sessionSubmit = sessionForm?.querySelector('button[type="submit"]');

  if (sessionDateInput) {
    applyDefaultDateIfEmpty(sessionDateInput);
  }

  if (sessionForm) {
    sessionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!sessionSubmit) return;

      const formData = new FormData(sessionForm);
      const payload = {
        game_id: gameId,
        game_title: String(formData.get("game_title") || "").trim() || (titleInput?.value.trim() || ""),
        session_date: String(formData.get("session_date") || "").trim(),
        playtime_minutes: Number(formData.get("playtime_minutes") || 0),
        sentiment: String(formData.get("sentiment") || "").trim(),
        comment: String(formData.get("comment") || "").trim() || null,
      };

      if (!payload.session_date) {
        if (sessionMessage) sessionMessage.textContent = "Session date is required.";
        sessionDateInput?.focus();
        return;
      }

      if (!Number.isFinite(payload.playtime_minutes) || payload.playtime_minutes <= 0) {
        if (sessionMessage) sessionMessage.textContent = "Enter playtime in minutes.";
        sessionPlaytimeInput?.focus();
        return;
      }

      if (!payload.sentiment) {
        if (sessionMessage) sessionMessage.textContent = "Select how the session felt.";
        return;
      }

      sessionSubmit.disabled = true;
      if (sessionMessage) sessionMessage.textContent = "Logging session...";

      try {
        await fetchJSON("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (sessionMessage) sessionMessage.textContent = "Session logged. Refreshing...";
        setTimeout(() => {
          window.location.reload();
        }, 600);
      } catch (error) {
        if (sessionMessage) {
          sessionMessage.textContent = error instanceof Error ? error.message : String(error);
        }
        sessionSubmit.disabled = false;
      }
    });
  }
}

async function initLibraryPage() {
  const libraryLists = new Map();
  document.querySelectorAll("[data-library-list]").forEach((element) => {
    const status = element.dataset.libraryList;
    if (status) {
      libraryLists.set(status, element);
    }
  });

  if (libraryLists.size === 0) {
    return;
  }

  async function renderLists() {
    const games = await fetchAndCacheGames({ force: true });
    const byEloDesc = (a, b) =>
      (Number(b.elo_rating) || 0) - (Number(a.elo_rating) || 0);

    const grouped = Object.create(null);
    games.forEach((game) => {
      const normalizedStatus = getStatusDefinition(game.status)?.value || DEFAULT_STATUS;
      if (!grouped[normalizedStatus]) {
        grouped[normalizedStatus] = [];
      }
      grouped[normalizedStatus].push(game);
    });

    STATUS_TAXONOMY.forEach((definition) => {
      const listElement = libraryLists.get(definition.value);
      if (!listElement) return;

      listElement.innerHTML = "";
      const entries = (grouped[definition.value] || []).sort(byEloDesc);
      if (entries.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty-state";
        empty.textContent = definition.emptyCopy;
        listElement.appendChild(empty);
        return;
      }

      entries.forEach((game) => {
        const card = createGameCard(game, {
          onDelete: renderLists,
          onUpdate: renderLists,
        });
        listElement.appendChild(card);
      });
    });
  }

  await renderLists();
}

async function initRankingsPage() {
  const statusSelect = document.getElementById("ranking-status");
  const pairContainer = document.getElementById("ranking-pair");
  const rankingList = document.getElementById("ranking-list");
  const rankingTitle = document.getElementById("ranking-table-title");
  if (!statusSelect || !pairContainer || !rankingList) return;

  statusSelect.innerHTML = "";
  STATUS_TAXONOMY.forEach(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    statusSelect.appendChild(option);
  });
  if (!STATUS_LOOKUP[statusSelect.value]) {
    statusSelect.value = DEFAULT_STATUS;
  }

  const state = {
    loadingPair: false,
    submitting: false,
    currentPair: null,
  };

  function setPairMessage(message, { isError = false, allowRetry = false } = {}) {
    pairContainer.innerHTML = "";
    const note = document.createElement("p");
    note.className = isError ? "pair-message pair-message--error" : "pair-message";
    note.textContent = message;
    pairContainer.appendChild(note);
    if (allowRetry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "pair-retry";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => loadPair(statusSelect.value, { force: true }));
      pairContainer.appendChild(retry);
    }
  }

  function renderPair(status, gameA, gameB) {
    pairContainer.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "pair-grid";

    [gameA, gameB].forEach((game) => {
      const card = document.createElement("article");
      card.className = "pair-card";

      const media = document.createElement("div");
      media.className = "pair-card__media";
      if (game.icon_url) {
        const img = document.createElement("img");
        img.src = game.icon_url;
        img.alt = `${game.title} artwork`;
        img.loading = "lazy";
        media.appendChild(img);
      } else {
        media.textContent = game.title.slice(0, 1).toUpperCase();
      }
      card.appendChild(media);

      const content = document.createElement("div");
      content.className = "pair-card__content";

      const title = document.createElement("h4");
      title.className = "pair-card__title";
      title.textContent = game.title;
      content.appendChild(title);

      if (Array.isArray(game.genres) && game.genres.length > 0) {
        const genres = document.createElement("div");
        genres.className = "pair-card__genres tag-list tag-list-inline";
        genres.innerHTML = buildTagElements(game.genres.slice(0, 4));
        content.appendChild(genres);
      }

      const description = document.createElement("p");
      description.className = "pair-card__description";
      description.textContent = game.short_description || "No description available yet.";
      content.appendChild(description);

      const actions = document.createElement("div");
      actions.className = "pair-card__actions";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "pair-card__action";
      button.textContent = "Pick this game";
      button.addEventListener("click", () => handlePairSelection(status, gameA, gameB, game.id, button));
      actions.appendChild(button);

      content.appendChild(actions);
      card.appendChild(content);
      grid.appendChild(card);
    });

    pairContainer.appendChild(grid);
    const feedback = document.createElement("p");
    feedback.className = "pair-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    pairContainer.appendChild(feedback);
    state.currentPair = { status, gameA, gameB, feedback };
  }

  async function loadPair(status, { force = false } = {}) {
    if (state.loadingPair && !force) {
      return;
    }
    state.loadingPair = true;
    setPairMessage("Loading next matchup...");

    try {
      const pair = await fetchJSON(`/api/rankings/${status}/pair`);
      if (pair.message) {
        setPairMessage(pair.message);
        state.currentPair = null;
        return;
      }
      renderPair(status, pair.game_a, pair.game_b);
    } catch (error) {
      setPairMessage(error instanceof Error ? error.message : String(error), {
        isError: true,
        allowRetry: true,
      });
      state.currentPair = null;
    } finally {
      state.loadingPair = false;
    }
  }

  function setPairInlineMessage(message) {
    if (!state.currentPair || !state.currentPair.feedback) return;
    state.currentPair.feedback.textContent = message;
  }

  async function handlePairSelection(status, gameA, gameB, winnerId, button) {
    if (state.submitting) return;
    state.submitting = true;
    button.disabled = true;
    setPairInlineMessage("Recording your choice...");
    try {
      await fetchJSON(`/api/rankings/${status}/compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_a_id: gameA.id,
          game_b_id: gameB.id,
          winner_id: winnerId,
        }),
      });
      setPairInlineMessage("Matchup recorded.");
      await loadRanking(status);
      await loadPair(status, { force: true });
    } catch (error) {
      setPairInlineMessage(error instanceof Error ? error.message : String(error));
    } finally {
      state.submitting = false;
      button.disabled = false;
    }
  }

  async function loadRanking(status) {
    try {
      const ranking = await fetchJSON(`/api/rankings/${status}`);
      rankingList.innerHTML = "";
      ranking.forEach((game) => {
        const item = document.createElement("li");
        item.innerHTML = `<span>${game.title}</span> <span class="ranking-score">${Math.round(
          game.elo_rating
        )}</span>`;
        rankingList.appendChild(item);
      });
      if (ranking.length === 0) {
        const item = document.createElement("li");
        item.className = "empty-state";
        item.textContent = "No games found for this list.";
        rankingList.appendChild(item);
      }
      if (rankingTitle) {
        const label = getStatusLabel(status);
        rankingTitle.textContent = `${label} ranking`;
      }
    } catch (error) {
      rankingList.innerHTML = "";
      const item = document.createElement("li");
      item.className = "empty-state";
      item.textContent = error instanceof Error ? error.message : String(error);
      rankingList.appendChild(item);
    }
  }

  statusSelect.addEventListener("change", () => {
    const status = statusSelect.value;
    loadRanking(status);
    loadPair(status, { force: true });
  });

  const initialStatus = statusSelect.value;
  await loadRanking(initialStatus);
  await loadPair(initialStatus, { force: true });
}

async function initSessionsPage() {
  const form = document.getElementById("session-form");
  const message = document.getElementById("session-form-message");
  const sessionsTableBody = document.querySelector("#sessions-table tbody");
  const sessionGameSelect = document.getElementById("session-game-select");
  const sessionGameTitleInput = document.getElementById("session-game-title");
  const sessionDateInput = document.getElementById("session-date");
  if (!form || !sessionsTableBody || !sessionGameSelect || !sessionGameTitleInput) return;

  let userEditedTitle = false;

  function resetTitleEditState() {
    userEditedTitle = false;
    delete sessionGameTitleInput.dataset.edited;
  }

  sessionGameTitleInput.addEventListener("input", () => {
    userEditedTitle = sessionGameTitleInput.value.trim().length > 0;
    if (userEditedTitle) {
      sessionGameTitleInput.dataset.edited = "true";
    } else {
      delete sessionGameTitleInput.dataset.edited;
    }
  });

  sessionGameSelect.addEventListener("change", () => {
    const selectedOption = sessionGameSelect.selectedOptions[0];
    if (selectedOption && selectedOption.value) {
      if (!userEditedTitle) {
        sessionGameTitleInput.value = selectedOption.textContent || "";
      }
    } else if (!userEditedTitle) {
      sessionGameTitleInput.value = "";
    }
  });

  async function populateGameOptions({ force = false } = {}) {
    const games = await fetchAndCacheGames({ force });
    sessionGameSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a game from your library";
    sessionGameSelect.appendChild(placeholder);

    games.forEach((game) => {
      const option = document.createElement("option");
      option.value = game.id;
      option.textContent = game.title;
      sessionGameSelect.appendChild(option);
    });
  }

  async function loadSessions() {
    try {
      const sessions = await fetchJSON("/api/sessions");
      sessionsTableBody.innerHTML = "";
      sessions.forEach((session) => {
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>${new Date(session.session_date).toLocaleDateString()}</td>
          <td>${session.game_title}</td>
          <td>${session.playtime_minutes} min</td>
          <td>${session.sentiment}</td>
          <td>${session.comment || ""}</td>
          <td><button type="button" data-id="${session.id}">Delete</button></td>
        `;
        const deleteBtn = row.querySelector("button");
        deleteBtn.addEventListener("click", async () => {
          if (!confirm("Remove this session?")) return;
          try {
            await fetchJSON(`/api/sessions/${session.id}`, { method: "DELETE" });
            await loadSessions();
          } catch (error) {
            alert(error.message);
          }
        });
        sessionsTableBody.appendChild(row);
      });
      if (sessions.length === 0) {
        const row = document.createElement("tr");
        row.innerHTML = '<td colspan="6" class="empty-state">No sessions logged yet.</td>';
        sessionsTableBody.appendChild(row);
      }
    } catch (error) {
      sessionsTableBody.innerHTML = `<tr><td colspan="6">${
        error instanceof Error ? error.message : String(error)
      }</td></tr>`;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
      session_date: formData.get("session_date"),
      playtime_minutes: formData.get("playtime_minutes"),
      sentiment: formData.get("sentiment"),
      comment: formData.get("comment"),
      game_title: String(formData.get("game_title") || "").trim(),
    };

    const selectedOption = sessionGameSelect.selectedOptions[0];
    if (selectedOption && selectedOption.value) {
      payload.game_id = selectedOption.value;
      if (!payload.game_title) {
        payload.game_title = (selectedOption.textContent || "").trim();
      }
    }

    if (!payload.game_title) {
      message.textContent = "Game title is required.";
      return;
    }

    try {
      await fetchJSON("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      message.textContent = "Session logged.";
      form.reset();
      resetTitleEditState();
      await populateGameOptions();
      applyDefaultDateIfEmpty(sessionDateInput);
      await loadSessions();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  await populateGameOptions({ force: true });
  resetTitleEditState();
  applyDefaultDateIfEmpty(sessionDateInput);
  await loadSessions();
}

async function initSettingsPage() {
  const steamForm = document.getElementById("steam-form");
  const steamResult = document.getElementById("steam-result");
  const libraryImportForm = document.getElementById("library-import-form");
  const wishlistImportForm = document.getElementById("wishlist-import-form");
  const libraryImportResult = document.getElementById("library-import-result");
  const wishlistImportResult = document.getElementById("wishlist-import-result");

  steamForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const appIdInput = document.getElementById("steam-search-id");
    if (!appIdInput) return;
    const appId = appIdInput.value.trim();
    if (!appId) {
      steamResult.textContent = "Enter an App ID.";
      return;
    }
    steamResult.textContent = "Fetching...";
    try {
      const data = await fetchJSON(`/api/steam/${appId}`);
      steamResult.textContent = JSON.stringify(data, null, 2);
    } catch (error) {
      steamResult.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  async function handleSteamImport(
    form,
    url,
    resultElement,
    { defaultStatus = DEFAULT_STATUS } = {}
  ) {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.steam_id = String(payload.steam_id || "").trim();
    if (!payload.steam_id) {
      resultElement.textContent = "Steam ID is required.";
      return;
    }
    if (payload.status !== undefined) {
      payload.status = String(payload.status || defaultStatus).trim().toLowerCase();
    }
    if (payload.api_key !== undefined) {
      payload.api_key = String(payload.api_key || "").trim();
      if (!payload.api_key) {
        delete payload.api_key;
      }
    }

    resultElement.textContent = "Importing...";
    try {
      const data = await fetchJSON(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const importedTitles = (data.imported || []).map((game) => game.title);
      let message = `Imported ${data.imported_count} game(s), skipped ${data.skipped_count}.`;
      if (importedTitles.length > 0) {
        message += ` Added: ${importedTitles.join(", ")}.`;
      }
      resultElement.textContent = message;
      if (importedTitles.length > 0) {
        await fetchAndCacheGames({ force: true });
      }
    } catch (error) {
      resultElement.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  libraryImportForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!libraryImportResult) return;
    await handleSteamImport(
      libraryImportForm,
      "/api/steam/import/library",
      libraryImportResult,
      { defaultStatus: DEFAULT_STATUS }
    );
  });

  wishlistImportForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!wishlistImportResult) return;
    await handleSteamImport(
      wishlistImportForm,
      "/api/steam/import/wishlist",
      wishlistImportResult,
      { defaultStatus: "wishlist" }
    );
  });
}

async function bootstrap() {
  await Promise.all([
    initBacklogImportPage(),
    initWishlistCsvImportPage(),
    initAddGamePage(),
    initGameDetailPage(),
    initLibraryPage(),
    initRankingsPage(),
    initSessionsPage(),
    initInsightsPage(),
    initSettingsPage(),
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error(error);
  });
});
