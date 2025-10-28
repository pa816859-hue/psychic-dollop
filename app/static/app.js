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

async function initBacklogImportPage() {
  const form = document.getElementById("backlog-import-form");
  if (!form) return;

  const fileInput = document.getElementById("backlog-import-file");
  const result = document.getElementById("backlog-import-result");
  const summary = document.getElementById("backlog-import-summary");
  const importedList = document.getElementById("backlog-import-imported");
  const skippedList = document.getElementById("backlog-import-skipped");

  function resetSummary() {
    if (importedList) importedList.innerHTML = "";
    if (skippedList) skippedList.innerHTML = "";
    summary?.classList.add("hidden");
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

  function resetSummary() {
    if (importedList) importedList.innerHTML = "";
    if (skippedList) skippedList.innerHTML = "";
    summary?.classList.add("hidden");
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
  statusBadge.textContent = game.status === "backlog" ? "Backlog" : "Wishlist";
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
  [
    { value: "backlog", label: "Backlog" },
    { value: "wishlist", label: "Wishlist" },
  ].forEach(({ value, label }) => {
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
  purchaseHint.textContent = "Required for backlog entries.";
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
    const isBacklog = statusSelect.value === "backlog";
    purchaseInput.required = isBacklog;
    purchaseField.classList.toggle("is-optional", !isBacklog);
    if (isBacklog) {
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

    if (payload.status === "wishlist") {
      payload.purchase_date = null;
    } else if (!payload.purchase_date) {
      editMessage.textContent = "Purchase date is required for backlog entries.";
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
    const isBacklog = statusSelect.value === "backlog";
    purchaseInput.required = isBacklog;
    if (purchaseGroup) {
      purchaseGroup.classList.toggle("is-optional", !isBacklog);
    }
    if (isBacklog) {
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
    payload.status = String(payload.status || "backlog").trim().toLowerCase();
    payload.steam_app_id = String(payload.steam_app_id || "").trim();
    payload.thoughts = String(payload.thoughts || "").trim();
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
      thoughtsInput?.value = "";
      await fetchAndCacheGames({ force: true });
      updatePurchaseRequirement();
      if (statusSelect.value === "backlog") {
        applyDefaultDateIfEmpty(purchaseInput);
      } else if (purchaseInput) {
        purchaseInput.value = "";
      }
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  updatePurchaseRequirement();
  clearSteamMetadataPreview();
}

async function initLibraryPage() {
  const backlogList = document.getElementById("backlog-list");
  const wishlistList = document.getElementById("wishlist-list");
  if (!backlogList && !wishlistList) return;

  async function renderLists() {
    const games = await fetchAndCacheGames({ force: true });
    const byEloDesc = (a, b) =>
      (Number(b.elo_rating) || 0) - (Number(a.elo_rating) || 0);

    if (backlogList) {
      backlogList.innerHTML = "";
      const backlogGames = games
        .filter((game) => game.status === "backlog")
        .sort(byEloDesc);
      backlogGames.forEach((game) => {
        const card = createGameCard(game, {
          onDelete: renderLists,
          onUpdate: renderLists,
        });
        backlogList.appendChild(card);
      });
    }

    if (wishlistList) {
      wishlistList.innerHTML = "";
      const wishlistGames = games
        .filter((game) => game.status === "wishlist")
        .sort(byEloDesc);
      wishlistGames.forEach((game) => {
        const card = createGameCard(game, {
          onDelete: renderLists,
          onUpdate: renderLists,
        });
        wishlistList.appendChild(card);
      });
    }

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
    initBacklogImportPage(),
    initWishlistCsvImportPage(),
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
