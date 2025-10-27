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
const datalist = document.getElementById("game-titles");
const steamForm = document.getElementById("steam-form");
const steamResult = document.getElementById("steam-result");
const libraryImportForm = document.getElementById("library-import-form");
const wishlistImportForm = document.getElementById("wishlist-import-form");
const libraryImportResult = document.getElementById("library-import-result");
const wishlistImportResult = document.getElementById("wishlist-import-result");

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

  const title = document.createElement("h4");
  title.textContent = `${game.title}`;
  li.appendChild(title);

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

async function loadGames() {
  try {
    const games = await fetchJSON("/api/games");
    backlogList.innerHTML = "";
    wishlistList.innerHTML = "";
    datalist.innerHTML = "";

    games.forEach((game) => {
      const option = document.createElement("option");
      option.value = game.title;
      option.dataset.gameId = game.id;
      datalist.appendChild(option);

      const card = createGameCard(game);
      if (game.status === "backlog") {
        backlogList.appendChild(card);
      } else {
        wishlistList.appendChild(card);
      }
    });

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
  const genres = formData
    .get("genres")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const payload = {
    title: formData.get("title"),
    status: formData.get("status"),
    steam_app_id: formData.get("steam_app_id"),
    modes,
    genres,
  };

  try {
    await fetchJSON("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    gameMessage.textContent = "Game added.";
    addGameForm.reset();
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

  // Map game title to ID if it matches datalist entry
  const option = Array.from(datalist.options).find(
    (opt) => opt.value.toLowerCase() === payload.game_title.toLowerCase()
  );
  if (option?.dataset.gameId) {
    payload.game_id = option.dataset.gameId;
  }

  try {
    await fetchJSON("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    sessionMessage.textContent = "Session logged.";
    sessionForm.reset();
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
  const today = new Date().toISOString().split("T")[0];
  const dateInput = document.getElementById("session-date");
  if (dateInput) {
    dateInput.value = today;
  }
}

bootstrap().catch((error) => {
  console.error(error);
});
