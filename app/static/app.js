const state = {
  cachedGames: [],
};

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

async function fetchAndCacheGames({ force = false } = {}) {
  if (!force && state.cachedGames.length > 0) {
    return state.cachedGames;
  }
  const games = await fetchJSON("/api/games");
  state.cachedGames = games;
  return games;
}

function createGameCard(game, { onDelete } = {}) {
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
  title.textContent = game.title;
  header.appendChild(title);
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
    const isBacklog = statusSelect.value === "backlog";
    purchaseInput.required = isBacklog;
    if (purchaseGroup) {
      purchaseGroup.classList.toggle("is-optional", !isBacklog);
    }
    if (isBacklog && !purchaseInput.value) {
      applyDefaultDateIfEmpty(purchaseInput);
    }
    if (!isBacklog && purchaseInput.value) {
      // Leave the value intact in case the user wants to keep it
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
      modes: Array.from(form.querySelectorAll(".mode-option:checked")).map((input) =>
        input.value.trim()
      ),
    };

    payload.title = String(payload.title || "").trim();
    payload.status = String(payload.status || "backlog").trim().toLowerCase();
    payload.steam_app_id = String(payload.steam_app_id || "").trim();
    payload.purchase_date = String(payload.purchase_date || "").trim();
    payload.start_date = String(payload.start_date || "").trim();
    payload.finish_date = String(payload.finish_date || "").trim();

    if (!payload.title) {
      message.textContent = "Title is required.";
      return;
    }

    if (payload.status === "backlog" && !payload.purchase_date) {
      message.textContent = "Purchase date is required for backlog entries.";
      return;
    }

    if (!payload.steam_app_id) {
      delete payload.steam_app_id;
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
      await fetchAndCacheGames({ force: true });
      updatePurchaseRequirement();
      applyDefaultDateIfEmpty(purchaseInput);
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  updatePurchaseRequirement();
  applyDefaultDateIfEmpty(purchaseInput);
  clearSteamMetadataPreview();
}

async function initLibraryPage() {
  const backlogList = document.getElementById("backlog-list");
  const wishlistList = document.getElementById("wishlist-list");
  if (!backlogList && !wishlistList) return;

  async function renderLists() {
    const games = await fetchAndCacheGames({ force: true });

    if (backlogList) {
      backlogList.innerHTML = "";
    }
    if (wishlistList) {
      wishlistList.innerHTML = "";
    }

    games.forEach((game) => {
      const card = createGameCard(game, { onDelete: renderLists });
      if (game.status === "backlog" && backlogList) {
        backlogList.appendChild(card);
      } else if (wishlistList) {
        wishlistList.appendChild(card);
      }
    });

    if (backlogList && backlogList.children.length === 0) {
      const item = document.createElement("li");
      item.className = "empty-state";
      item.textContent = "No backlog games yet.";
      backlogList.appendChild(item);
    }
    if (wishlistList && wishlistList.children.length === 0) {
      const item = document.createElement("li");
      item.className = "empty-state";
      item.textContent = "No wishlist games yet.";
      wishlistList.appendChild(item);
    }
  }

  await renderLists();
}

async function initRankingsPage() {
  const statusSelect = document.getElementById("ranking-status");
  const pairContainer = document.getElementById("ranking-pair");
  const rankingList = document.getElementById("ranking-list");
  const rankingTitle = document.getElementById("ranking-table-title");
  if (!statusSelect || !pairContainer || !rankingList) return;

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
        rankingTitle.textContent =
          status === "backlog" ? "Backlog ranking" : "Wishlist ranking";
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
  const sessionGameInput = document.getElementById("session-game-input");
  const sessionGameIdInput = document.getElementById("session-game-id");
  const sessionGameOptions = document.getElementById("session-game-options");
  const sessionDateInput = document.getElementById("session-date");
  if (!form || !sessionsTableBody || !sessionGameInput || !sessionGameOptions) return;

  sessionGameOptions.setAttribute("role", "listbox");

  let sessionGameMatches = [];
  let sessionGameHighlightIndex = -1;

  function updateSessionGameHighlight() {
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

  function clearSessionGameHighlight() {
    sessionGameHighlightIndex = -1;
    updateSessionGameHighlight();
  }

  function hideSessionGameOptions() {
    sessionGameOptions.classList.add("hidden");
    sessionGameOptions.innerHTML = "";
    sessionGameMatches = [];
    clearSessionGameHighlight();
  }

  function selectSessionGame(game) {
    sessionGameInput.value = game.title;
    if (sessionGameIdInput) {
      sessionGameIdInput.value = game.id;
    }
    hideSessionGameOptions();
  }

  function renderSessionGameOptions(query = "") {
    const normalized = query.trim().toLowerCase();
    const matches = state.cachedGames
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
      sessionGameMatches = [];
      clearSessionGameHighlight();
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
        sessionGameHighlightIndex = index;
        updateSessionGameHighlight();
      });

      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectSessionGame(game);
        sessionGameInput.focus();
      });

      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectSessionGame(game);
          sessionGameInput.focus();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          const next = Math.min(index + 1, matches.length - 1);
          const nextItem = sessionGameOptions.querySelector(`li[data-index="${next}"]`);
          sessionGameHighlightIndex = next;
          updateSessionGameHighlight();
          (nextItem || sessionGameInput).focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          const prev = index - 1 < 0 ? -1 : index - 1;
          if (prev === -1) {
            clearSessionGameHighlight();
            sessionGameInput.focus();
          } else {
            const prevItem = sessionGameOptions.querySelector(`li[data-index="${prev}"]`);
            sessionGameHighlightIndex = prev;
            updateSessionGameHighlight();
            (prevItem || sessionGameInput).focus();
          }
        } else if (event.key === "Escape") {
          hideSessionGameOptions();
          sessionGameInput.focus();
        }
      });

      sessionGameOptions.appendChild(item);
    });

    sessionGameOptions.classList.remove("hidden");
    updateSessionGameHighlight();
  }

  sessionGameInput.addEventListener("input", () => {
    if (sessionGameIdInput) {
      sessionGameIdInput.value = "";
    }
    renderSessionGameOptions(sessionGameInput.value);
  });

  sessionGameInput.addEventListener("focus", () => {
    renderSessionGameOptions(sessionGameInput.value);
  });

  sessionGameInput.addEventListener("blur", () => {
    setTimeout(() => hideSessionGameOptions(), 120);
  });

  sessionGameInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      if (sessionGameMatches.length > 0) {
        event.preventDefault();
        const nextIndex =
          sessionGameHighlightIndex + 1 >= sessionGameMatches.length
            ? 0
            : sessionGameHighlightIndex + 1;
        sessionGameHighlightIndex = nextIndex;
        updateSessionGameHighlight();
      }
    } else if (event.key === "ArrowUp") {
      if (sessionGameMatches.length > 0) {
        event.preventDefault();
        const nextIndex =
          sessionGameHighlightIndex <= 0
            ? sessionGameMatches.length - 1
            : sessionGameHighlightIndex - 1;
        sessionGameHighlightIndex = nextIndex;
        updateSessionGameHighlight();
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
      game_title: formData.get("game_title"),
      session_date: formData.get("session_date"),
      playtime_minutes: formData.get("playtime_minutes"),
      sentiment: formData.get("sentiment"),
      comment: formData.get("comment"),
    };

    if (sessionGameIdInput?.value) {
      payload.game_id = sessionGameIdInput.value;
    }

    try {
      await fetchJSON("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      message.textContent = "Session logged.";
      form.reset();
      hideSessionGameOptions();
      if (sessionGameIdInput) {
        sessionGameIdInput.value = "";
      }
      applyDefaultDateIfEmpty(sessionDateInput);
      await loadSessions();
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  await fetchAndCacheGames({ force: true });
  renderSessionGameOptions("");
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

  async function handleSteamImport(form, url, resultElement) {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());
    payload.steam_id = String(payload.steam_id || "").trim();
    if (!payload.steam_id) {
      resultElement.textContent = "Steam ID is required.";
      return;
    }
    if (payload.status !== undefined) {
      payload.status = String(payload.status || "").trim();
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
      libraryImportResult
    );
  });

  wishlistImportForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!wishlistImportResult) return;
    await handleSteamImport(
      wishlistImportForm,
      "/api/steam/import/wishlist",
      wishlistImportResult
    );
  });
}

async function bootstrap() {
  await Promise.all([
    initAddGamePage(),
    initLibraryPage(),
    initRankingsPage(),
    initSessionsPage(),
    initSettingsPage(),
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error(error);
  });
});
