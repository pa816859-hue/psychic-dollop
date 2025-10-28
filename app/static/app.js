const addGameForm = document.getElementById("add-game-form");
const gameMessage = document.getElementById("game-form-message");
const backlogList = document.getElementById("backlog-list");
const wishlistList = document.getElementById("wishlist-list");
const backlogRanking = document.getElementById("backlog-ranking");
const wishlistRanking = document.getElementById("wishlist-ranking");
const addGameTitleInput = document.getElementById("title");
const sessionForm = document.getElementById("session-form");
const sessionMessage = document.getElementById("session-form-message");
const sessionsTableBody = document.querySelector("#sessions-table tbody");
const steamAppIdInput = document.getElementById("steam-app-id");
const steamAppIdStatus = document.getElementById("steam-app-id-status");
const detectedGenresContainer = document.getElementById("detected-genres");
const detectedGenresHint = document.getElementById("detected-genres-hint");
const iconPreview = document.getElementById("icon-preview");
const sessionGameInput = document.getElementById("session-game-input");
const sessionGameIdInput = document.getElementById("session-game-id");
const sessionGameOptions = document.getElementById("session-game-options");
const steamForm = document.getElementById("steam-form");
const steamResult = document.getElementById("steam-result");
const libraryImportForm = document.getElementById("library-import-form");
const wishlistImportForm = document.getElementById("wishlist-import-form");
const libraryImportResult = document.getElementById("library-import-result");
const wishlistImportResult = document.getElementById("wishlist-import-result");
const pairContainers = {
  backlog: document.getElementById("backlog-pair"),
  wishlist: document.getElementById("wishlist-pair"),
};
const defaultSteamStatusMessage =
  (steamAppIdStatus?.textContent || "").trim() ||
  "Add an App ID to fetch genres and artwork.";
const defaultGenresHintMessage =
  (detectedGenresHint?.textContent || "").trim() ||
  "Genres will appear after fetching from Steam.";
const defaultArtworkMessage =
  (iconPreview?.dataset.defaultMessage || "").trim() ||
  "Artwork will appear after fetching from Steam.";

let cachedGames = [];
let steamLookupTimeout;
let steamLookupToken = 0;
let addGameTitleAutofilled = false;
let sessionGameMatches = [];
let sessionGameHighlightIndex = -1;
const pairState = {
  backlog: { loading: false, submitting: false, current: null, feedback: null },
  wishlist: { loading: false, submitting: false, current: null, feedback: null },
};

sessionGameOptions?.setAttribute("role", "listbox");

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let errorText = "Request failed";
    try {
      const data = await response.json();
      errorText = data.error || JSON.stringify(data);
    } catch (error) {
      errorText = response.statusText;
    }
    throw new Error(errorText);
  }
  return response.json();
}

function buildTagElements(items) {
  return items.map((item) => `<span class="tag">${item}</span>`).join(" ");
}

function clearTitleAutofill() {
  addGameTitleAutofilled = false;
}

function applyTitleAutofill(value) {
  if (!addGameTitleInput) return;
  const trimmed = (value || "").trim();
  if (!trimmed) return;
  if (!addGameTitleInput.value.trim() || addGameTitleAutofilled) {
    addGameTitleInput.value = trimmed;
    addGameTitleAutofilled = true;
  }
}

function createGameCard(game) {
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

  const title = document.createElement("h4");
  title.textContent = `${game.title}`;
  header.appendChild(title);
  li.appendChild(header);

  const rating = document.createElement("div");
  rating.className = "meta";
  rating.textContent = `ELO: ${Math.round(game.elo_rating)}`;
  li.appendChild(rating);

  if (game.modes.length > 0) {
    const modes = document.createElement("div");
    modes.className = "tag-list";
    modes.innerHTML = buildTagElements(game.modes);
    li.appendChild(modes);
  }

  if (game.genres.length > 0) {
    const genres = document.createElement("div");
    genres.className = "tag-list";
    genres.innerHTML = buildTagElements(game.genres);
    li.appendChild(genres);
  }

  const actions = document.createElement("div");
  actions.className = "meta";

  if (game.steam_app_id) {
    const link = document.createElement("a");
    link.href = `https://store.steampowered.com/app/${game.steam_app_id}/`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Steam";
    actions.appendChild(link);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "Remove";
  deleteBtn.type = "button";
  deleteBtn.style.background = "#ff5d5d";
  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Delete ${game.title}?`)) return;
    try {
      await fetchJSON(`/api/games/${game.id}`, { method: "DELETE" });
      await loadGames();
    } catch (error) {
      alert(error.message);
    }
  });
  actions.appendChild(deleteBtn);

  li.appendChild(actions);
  return li;
}

function updateSessionGameHighlight() {
  if (!sessionGameOptions) return;
  const items = Array.from(sessionGameOptions.querySelectorAll("li"));
  items.forEach((item, index) => {
    if (index === sessionGameHighlightIndex) {
      item.classList.add("is-active");
      item.setAttribute("aria-selected", "true");
      item.scrollIntoView({ block: "nearest" });
    } else {
      item.classList.remove("is-active");
      item.setAttribute("aria-selected", "false");
    }
  });
}

function highlightSessionGame(index) {
  sessionGameHighlightIndex = index;
  updateSessionGameHighlight();
}

function clearSessionGameHighlight() {
  sessionGameHighlightIndex = -1;
  updateSessionGameHighlight();
}

function hideSessionGameOptions() {
  if (sessionGameOptions) {
    sessionGameOptions.classList.add("hidden");
    sessionGameOptions.innerHTML = "";
  }
  sessionGameMatches = [];
  clearSessionGameHighlight();
}

function selectSessionGame(game) {
  if (sessionGameInput) {
    sessionGameInput.value = game.title;
  }
  if (sessionGameIdInput) {
    sessionGameIdInput.value = game.id;
  }
  hideSessionGameOptions();
}

function renderSessionGameOptions(query = "") {
  if (!sessionGameOptions) return;

  const normalized = query.trim().toLowerCase();
  const matches = cachedGames
    .filter((game) => {
      if (!normalized) return true;
      const titleMatch = game.title.toLowerCase().includes(normalized);
      const idMatch = String(game.id).startsWith(normalized);
      return titleMatch || idMatch;
    })
    .slice(0, 10);

  sessionGameOptions.innerHTML = "";
  if (matches.length === 0) {
    sessionGameOptions.classList.add("hidden");
    return;
  }

  sessionGameMatches = matches;
  if (matches.length > 0 && normalized) {
    sessionGameHighlightIndex = 0;
  } else {
    clearSessionGameHighlight();
  }

  matches.forEach((game, index) => {
    const item = document.createElement("li");
    item.className = "searchable-option";
    item.tabIndex = 0;
    item.setAttribute("role", "option");
    item.dataset.index = String(index);

    const inner = document.createElement("div");
    inner.className = "searchable-option__inner";

    if (game.icon_url) {
      const art = document.createElement("img");
      art.src = game.icon_url;
      art.alt = "";
      art.loading = "lazy";
      art.className = "searchable-option__art";
      inner.appendChild(art);
    }

    const text = document.createElement("div");
    text.className = "searchable-option__text";

    const title = document.createElement("span");
    title.className = "searchable-option__title";
    title.textContent = game.title;
    text.appendChild(title);

    const status = document.createElement("span");
    status.className = "searchable-option__status";
    const listLabel = game.status === "backlog" ? "Backlog" : "Wishlist";
    status.textContent = `${listLabel} • #${game.id}`;
    text.appendChild(status);

    inner.appendChild(text);
    item.appendChild(inner);

    item.addEventListener("mouseenter", () => {
      highlightSessionGame(index);
    });

    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectSessionGame(game);
      sessionGameInput?.focus();
    });

    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectSessionGame(game);
        sessionGameInput?.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = Math.min(index + 1, matches.length - 1);
        const nextItem = sessionGameOptions?.querySelector(
          `li[data-index="${next}"]`
        );
        highlightSessionGame(next);
        (nextItem || sessionGameInput)?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const prev = index - 1 < 0 ? -1 : index - 1;
        if (prev === -1) {
          clearSessionGameHighlight();
          sessionGameInput?.focus();
        } else {
          const prevItem = sessionGameOptions?.querySelector(
            `li[data-index="${prev}"]`
          );
          highlightSessionGame(prev);
          (prevItem || sessionGameInput)?.focus();
        }
      } else if (event.key === "Escape") {
        hideSessionGameOptions();
        sessionGameInput?.focus();
      }
    });

    sessionGameOptions.appendChild(item);
  });

  sessionGameOptions.classList.remove("hidden");
  updateSessionGameHighlight();
}

function clearSteamMetadataPreview(message) {
  if (detectedGenresContainer) {
    detectedGenresContainer.innerHTML = "";
  }
  if (detectedGenresHint) {
    detectedGenresHint.textContent = message || defaultGenresHintMessage;
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
    const message = error instanceof Error ? error.message : String(error);
    clearSteamMetadataPreview(message);
    if (steamAppIdStatus) {
      steamAppIdStatus.textContent = message;
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

sessionGameInput?.addEventListener("input", () => {
  if (sessionGameIdInput) {
    sessionGameIdInput.value = "";
  }
  renderSessionGameOptions(sessionGameInput.value);
});

sessionGameInput?.addEventListener("focus", () => {
  renderSessionGameOptions(sessionGameInput.value);
});

sessionGameInput?.addEventListener("blur", () => {
  setTimeout(() => hideSessionGameOptions(), 120);
});

addGameTitleInput?.addEventListener("input", () => {
  clearTitleAutofill();
});

sessionGameInput?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    if (sessionGameMatches.length > 0) {
      event.preventDefault();
      const nextIndex =
        sessionGameHighlightIndex + 1 >= sessionGameMatches.length
          ? 0
          : sessionGameHighlightIndex + 1;
      highlightSessionGame(nextIndex);
    }
  } else if (event.key === "ArrowUp") {
    if (sessionGameMatches.length > 0) {
      event.preventDefault();
      const nextIndex =
        sessionGameHighlightIndex <= 0
          ? sessionGameMatches.length - 1
          : sessionGameHighlightIndex - 1;
      highlightSessionGame(nextIndex);
    }
  } else if (event.key === "Enter") {
    if (sessionGameHighlightIndex >= 0) {
      event.preventDefault();
      const selected = sessionGameMatches[sessionGameHighlightIndex];
      if (selected) {
        selectSessionGame(selected);
      }
    }
  } else if (event.key === "Escape") {
    hideSessionGameOptions();
  }
});

steamAppIdInput?.addEventListener("input", scheduleSteamLookup);
steamAppIdInput?.addEventListener("blur", () => {
  if (!steamAppIdInput.value.trim()) {
    clearSteamMetadataPreview();
    if (steamAppIdStatus) {
      steamAppIdStatus.textContent = defaultSteamStatusMessage;
    }
  }
});

async function loadGames() {
  try {
    const games = await fetchJSON("/api/games");
    backlogList.innerHTML = "";
    wishlistList.innerHTML = "";

    cachedGames = games;

    games.forEach((game) => {
      const card = createGameCard(game);
      if (game.status === "backlog") {
        backlogList.appendChild(card);
      } else {
        wishlistList.appendChild(card);
      }
    });

    if (sessionGameIdInput) {
      const selected = games.find(
        (game) => String(game.id) === String(sessionGameIdInput.value || "")
      );
      if (selected && sessionGameInput) {
        sessionGameInput.value = selected.title;
      }
    }

    if (document.activeElement === sessionGameInput) {
      renderSessionGameOptions(sessionGameInput.value);
    } else {
      hideSessionGameOptions();
    }

    await refreshRankings();
    ensurePairLoaded("backlog");
    ensurePairLoaded("wishlist");
  } catch (error) {
    gameMessage.textContent = error.message;
  }
}

async function refreshRankings() {
  const statuses = ["backlog", "wishlist"];
  const containers = {
    backlog: backlogRanking,
    wishlist: wishlistRanking,
  };

  for (const status of statuses) {
    const list = containers[status];
    list.innerHTML = "";
    try {
      const ranking = await fetchJSON(`/api/rankings/${status}`);
      ranking.forEach((game, index) => {
        const item = document.createElement("li");
        item.innerHTML = `<span>${index + 1}. ${game.title}</span><span>${Math.round(
          game.elo_rating
        )}</span>`;
        list.appendChild(item);
      });
    } catch (error) {
      const item = document.createElement("li");
      item.textContent = error.message;
      list.appendChild(item);
    }
  }
}

addGameForm?.addEventListener("reset", () => {
  clearTitleAutofill();
});

addGameForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(addGameForm);
  const modes = Array.from(
    addGameForm.querySelectorAll(".mode-option:checked")
  ).map((input) => input.value);

  const payload = {
    title: formData.get("title"),
    status: formData.get("status"),
    steam_app_id: formData.get("steam_app_id"),
    modes,
  };

  try {
    await fetchJSON("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    gameMessage.textContent = "Game added.";
    addGameForm.reset();
    clearTitleAutofill();
    clearSteamMetadataPreview();
    if (steamAppIdStatus) {
      steamAppIdStatus.textContent = defaultSteamStatusMessage;
    }
    await loadGames();
  } catch (error) {
    gameMessage.textContent = error.message;
  }
});

function setPairMessage(status, message, options = {}) {
  const container = pairContainers[status];
  if (!container) return;
  const { isError = false, allowRetry = false } = options;
  container.innerHTML = "";
  const messageEl = document.createElement("p");
  messageEl.className = "pair-message";
  if (isError) {
    messageEl.classList.add("pair-message--error");
  }
  messageEl.textContent = message;
  container.appendChild(messageEl);
  if (isError && allowRetry) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "pair-retry";
    retryButton.textContent = "Try again";
    retryButton.addEventListener("click", () => {
      loadPair(status, { force: true });
    });
    container.appendChild(retryButton);
  }
  pairState[status].current = null;
  pairState[status].feedback = null;
}

function showPairInlineMessage(status, message, isError = false) {
  const feedback = pairState[status].feedback;
  if (!feedback) return;
  if (message) {
    feedback.textContent = message;
    feedback.classList.toggle("pair-feedback--error", Boolean(isError));
  } else {
    feedback.textContent = "";
    feedback.classList.remove("pair-feedback--error");
  }
}

async function handlePairSelection(status, gameA, gameB, winnerId, trigger) {
  const state = pairState[status];
  if (state.submitting) return;
  state.submitting = true;

  const originalText = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = "Recording...";
  showPairInlineMessage(status, "");

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
    await refreshRankings();
    await loadPair(status, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trigger.disabled = false;
    trigger.textContent = originalText;
    showPairInlineMessage(status, message, true);
  } finally {
    state.submitting = false;
  }
}

function renderPair(container, status, gameA, gameB) {
  const state = pairState[status];
  state.current = { gameA, gameB };
  state.feedback = null;

  container.innerHTML = "";

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

    if (game.genres && game.genres.length > 0) {
      const genres = document.createElement("div");
      genres.className = "pair-card__genres tag-list tag-list-inline";
      genres.innerHTML = buildTagElements(game.genres.slice(0, 4));
      content.appendChild(genres);
    }

    const description = document.createElement("p");
    description.className = "pair-card__description";
    description.textContent =
      game.short_description || "No description available yet.";
    content.appendChild(description);

    const actions = document.createElement("div");
    actions.className = "pair-card__actions";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "pair-card__action";
    button.textContent = "Pick this game";
    button.addEventListener("click", () =>
      handlePairSelection(status, gameA, gameB, game.id, button)
    );
    actions.appendChild(button);

    content.appendChild(actions);
    card.appendChild(content);
    grid.appendChild(card);
  });

  container.appendChild(grid);

  const feedback = document.createElement("p");
  feedback.className = "pair-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  container.appendChild(feedback);
  state.feedback = feedback;
  showPairInlineMessage(status, "");
}

async function loadPair(status, options = {}) {
  const container = pairContainers[status];
  if (!container) return;

  const state = pairState[status];
  if (state.loading && !options.force) {
    return;
  }

  state.loading = true;
  setPairMessage(status, "Loading next matchup...");

  try {
    const pair = await fetchJSON(`/api/rankings/${status}/pair`);
    if (pair.message) {
      setPairMessage(status, pair.message);
      return;
    }
    renderPair(container, status, pair.game_a, pair.game_b);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPairMessage(status, message, { isError: true, allowRetry: true });
  } finally {
    state.loading = false;
  }
}

function ensurePairLoaded(status) {
  const container = pairContainers[status];
  if (!container) return;
  const state = pairState[status];
  if (!state.current && !state.loading) {
    loadPair(status);
  }
}

sessionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(sessionForm);
  const payload = {
    game_title: formData.get("game_title"),
    session_date: formData.get("session_date"),
    playtime_minutes: formData.get("playtime_minutes"),
    sentiment: formData.get("sentiment"),
    comment: formData.get("comment"),
  };

  const normalizedTitle = String(payload.game_title || "").trim().toLowerCase();
  let matchedGame = cachedGames.find(
    (game) => game.title.toLowerCase() === normalizedTitle
  );

  if (sessionGameIdInput?.value) {
    matchedGame =
      cachedGames.find(
        (game) => String(game.id) === String(sessionGameIdInput.value)
      ) || matchedGame;
    payload.game_id = sessionGameIdInput.value;
    if (matchedGame) {
      payload.game_title = matchedGame.title;
    }
  } else if (matchedGame) {
    payload.game_id = matchedGame.id;
    payload.game_title = matchedGame.title;
  }

  try {
    await fetchJSON("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    sessionMessage.textContent = "Session logged.";
    sessionForm.reset();
    hideSessionGameOptions();
    if (sessionGameIdInput) {
      sessionGameIdInput.value = "";
    }
    await loadSessions();
  } catch (error) {
    sessionMessage.textContent = error.message;
  }
});

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
  } catch (error) {
    sessionsTableBody.innerHTML = `<tr><td colspan="6">${error.message}</td></tr>`;
  }
}

steamForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const appId = document.getElementById("steam-search-id").value.trim();
  if (!appId) {
    steamResult.textContent = "Enter an App ID.";
    return;
  }
  steamResult.textContent = "Fetching...";
  try {
    const data = await fetchJSON(`/api/steam/${appId}`);
    steamResult.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    steamResult.textContent = error.message;
  }
});

async function handleSteamImport(form, url, resultElement) {
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.steam_id = payload.steam_id?.trim();
  if (!payload.steam_id) {
    resultElement.textContent = "Steam ID is required.";
    return;
  }
  if (payload.status !== undefined) {
    payload.status = payload.status.trim();
  }
  if (payload.api_key !== undefined) {
    payload.api_key = payload.api_key.trim();
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
      await loadGames();
    }
  } catch (error) {
    resultElement.textContent = error.message;
  }
}

libraryImportForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await handleSteamImport(libraryImportForm, "/api/steam/import/library", libraryImportResult);
});

wishlistImportForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await handleSteamImport(
    wishlistImportForm,
    "/api/steam/import/wishlist",
    wishlistImportResult
  );
});

async function bootstrap() {
  await loadGames();
  await loadSessions();
  clearSteamMetadataPreview();
  if (steamAppIdInput?.value.trim()) {
    lookupSteamMetadata(steamAppIdInput.value.trim()).catch((error) => {
      console.error(error);
    });
  } else if (steamAppIdStatus) {
    steamAppIdStatus.textContent = defaultSteamStatusMessage;
  }
  const today = new Date().toISOString().split("T")[0];
  const dateInput = document.getElementById("session-date");
  if (dateInput) {
    dateInput.value = today;
  }
  ensurePairLoaded("backlog");
  ensurePairLoaded("wishlist");
}

bootstrap().catch((error) => {
  console.error(error);
});
