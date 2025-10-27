const addGameForm = document.getElementById("add-game-form");
const gameMessage = document.getElementById("game-form-message");
const backlogList = document.getElementById("backlog-list");
const wishlistList = document.getElementById("wishlist-list");
const backlogRanking = document.getElementById("backlog-ranking");
const wishlistRanking = document.getElementById("wishlist-ranking");
const pairButtons = document.querySelectorAll(".pair-btn");
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

function hideSessionGameOptions() {
  if (sessionGameOptions) {
    sessionGameOptions.classList.add("hidden");
    sessionGameOptions.innerHTML = "";
  }
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
    .filter((game) =>
      !normalized || game.title.toLowerCase().includes(normalized)
    )
    .slice(0, 10);

  sessionGameOptions.innerHTML = "";
  if (matches.length === 0) {
    sessionGameOptions.classList.add("hidden");
    return;
  }

  matches.forEach((game) => {
    const item = document.createElement("li");
    item.className = "searchable-option";
    item.tabIndex = 0;

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
    status.textContent = game.status === "backlog" ? "Backlog" : "Wishlist";
    text.appendChild(status);

    inner.appendChild(text);
    item.appendChild(inner);

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
        (item.nextElementSibling || sessionGameInput)?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        (item.previousElementSibling || sessionGameInput)?.focus();
      } else if (event.key === "Escape") {
        hideSessionGameOptions();
        sessionGameInput?.focus();
      }
    });

    sessionGameOptions.appendChild(item);
  });

  sessionGameOptions.classList.remove("hidden");
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

sessionGameInput?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    const first = sessionGameOptions?.querySelector("li");
    if (first) {
      event.preventDefault();
      first.focus();
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
    clearSteamMetadataPreview();
    if (steamAppIdStatus) {
      steamAppIdStatus.textContent = defaultSteamStatusMessage;
    }
    await loadGames();
  } catch (error) {
    gameMessage.textContent = error.message;
  }
});

pairButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const status = button.dataset.status;
    const panel = document.getElementById(`${status}-pair`);
    panel.textContent = "Loading pair...";
    try {
      const pair = await fetchJSON(`/api/rankings/${status}/pair`);
      if (pair.message) {
        panel.textContent = pair.message;
        return;
      }
      renderPair(panel, status, pair.game_a, pair.game_b);
    } catch (error) {
      panel.textContent = error.message;
    }
  });
});

function renderPair(container, status, gameA, gameB) {
  container.innerHTML = "";

  [
    { game: gameA, opponent: gameB },
    { game: gameB, opponent: gameA },
  ].forEach(({ game, opponent }) => {
    const row = document.createElement("div");
    row.className = "pair-choice";

    const label = document.createElement("span");
    label.textContent = game.title;
    row.appendChild(label);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Pick";
    button.addEventListener("click", async () => {
      try {
        await fetchJSON(`/api/rankings/${status}/compare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game_a_id: gameA.id,
            game_b_id: gameB.id,
            winner_id: game.id,
          }),
        });
        container.textContent = "Comparison saved.";
        await refreshRankings();
      } catch (error) {
        container.textContent = error.message;
      }
    });

    row.appendChild(button);
    container.appendChild(row);
  });
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
}

bootstrap().catch((error) => {
  console.error(error);
});
