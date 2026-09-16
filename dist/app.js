(() => {
  "use strict";

  const STORAGE_KEY = "blasentagebuch.state.v1";
  const CONFIG_KEY = "blasentagebuch.supabase.v1";
  const URGENCY_MARKER = /^\[\[harndrang:(leicht|mittel|stark)\]\]\s*/i;
  const DEFAULT_PRESETS = [
    { id: "builtin-water", default_key: "builtin-water", name: "Wasser", amount_ml: 250, builtIn: true },
    { id: "builtin-coffee", default_key: "builtin-coffee", name: "Kaffee", amount_ml: 200, builtIn: true },
    { id: "builtin-tea", default_key: "builtin-tea", name: "Tee", amount_ml: 250, builtIn: true },
    { id: "builtin-juice", default_key: "builtin-juice", name: "Saft", amount_ml: 200, builtIn: true }
  ];

  const freshState = () => ({ entries: [], presets: [], defaultsMaterialized: false, nightStart: "22:00", nightEnd: "06:00", themeMode: "auto" });
  let state = loadState();
  let entryKind = "drink";
  let currentView = "today";
  let supabaseClient = null;
  let currentUser = null;
  let syncInProgress = false;
  let installPrompt = null;
  let toastTimer = null;
  let occurredAtManuallySet = false;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return { ...freshState(), ...saved, entries: (saved.entries || []).map(normalizeEntry) };
    } catch {
      return freshState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function nowLocalInput(date = new Date()) {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  }

  function resolvedTheme(mode = state.themeMode) {
    if (mode === "dark" || mode === "light") return mode;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme() {
    if (!["auto", "light", "dark"].includes(state.themeMode)) state.themeMode = "auto";
    const theme = resolvedTheme();
    document.documentElement.dataset.colorScheme = theme;
    $("#theme-color-meta").content = theme === "dark" ? "#0b1312" : "#eef5f3";
    $("#theme-icon").textContent = theme === "dark" ? "☀︎" : "☾";
    $("#theme-toggle").setAttribute("aria-label", theme === "dark" ? "Helles Design einschalten" : "Dunkles Design einschalten");
    $("#theme-toggle").title = theme === "dark" ? "Helles Design einschalten" : "Dunkles Design einschalten";
    $$('[data-theme-mode]').forEach((button) => {
      const active = button.dataset.themeMode === state.themeMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function setThemeMode(mode) {
    state.themeMode = ["auto", "light", "dark"].includes(mode) ? mode : "auto";
    saveState();
    applyTheme();
  }

  function updateEntryTimeSummary() {
    const input = $("#occurred-at");
    if (!input?.value) return;
    const date = new Date(input.value);
    if (Number.isNaN(date.getTime())) return;
    const time = formatDate(date, { hour: "2-digit", minute: "2-digit" });
    const differentDay = localDayKey(date) !== localDayKey(new Date());
    const datePart = differentDay ? `${formatDate(date, { day: "2-digit", month: "2-digit" })} · ` : "";
    $("#entry-time-summary").textContent = `${occurredAtManuallySet ? "Geändert" : "Jetzt"} · ${datePart}${time} Uhr`;
  }

  function refreshCurrentEntryTime(force = false) {
    if (occurredAtManuallySet && !force) return;
    $("#occurred-at").value = nowLocalInput();
    occurredAtManuallySet = false;
    $("#use-current-time").hidden = true;
    updateEntryTimeSummary();
  }

  function localDayKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dateFromKey(key) {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function formatDate(value, options = { weekday: "short", day: "2-digit", month: "2-digit" }) {
    return new Intl.DateTimeFormat("de-DE", options).format(value instanceof Date ? value : new Date(value));
  }

  function formatAmount(value) {
    return `${new Intl.NumberFormat("de-DE").format(Math.round(value || 0))} ml`;
  }

  function normalizeEntry(entry) {
    if (entry.kind !== "urination") return { ...entry, urgency: null };
    const note = String(entry.note || "");
    const match = note.match(URGENCY_MARKER);
    return {
      ...entry,
      urgency: entry.urgency || (match ? match[1].toLowerCase() : null),
      note: match ? (note.replace(URGENCY_MARKER, "").trim() || null) : entry.note
    };
  }

  function encodedNote(entry) {
    const note = String(entry.note || "").trim();
    const marker = entry.kind === "urination" && entry.urgency ? `[[harndrang:${entry.urgency}]]` : "";
    return `${marker}${marker && note ? " " : ""}${note}`.slice(0, 160) || null;
  }

  function urgencyLabel(value) {
    return ({ leicht: "Leicht", mittel: "Mittel", stark: "Stark" })[value] || "";
  }

  function selectedRadioValue(name) {
    return $(`input[name="${name}"]:checked`)?.value || null;
  }

  function setRadioValue(name, value) {
    $$(`input[name="${name}"]`).forEach((input) => { input.checked = input.value === value; });
  }

  function updateQuickAmountSelection() {
    const amount = String(Number($("#amount").value || 0));
    $$(".quick-amounts button").forEach((button) => {
      const selected = amount !== "0" && button.dataset.amount === amount;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function activeEntries() {
    return state.entries.filter((entry) => !entry.deleted_at);
  }

  function activePresets() {
    const saved = state.presets.filter((preset) => !preset.deleted_at);
    return state.defaultsMaterialized ? saved : [...DEFAULT_PRESETS, ...saved];
  }

  function normalizedName(value) {
    return String(value || "").trim().toLocaleLowerCase("de-DE");
  }

  function materializeDefaultPresets() {
    if (state.defaultsMaterialized) return;
    const now = new Date().toISOString();
    const knownNames = new Set(state.presets.map((preset) => normalizedName(preset.name)));
    DEFAULT_PRESETS.forEach((preset) => {
      if (knownNames.has(normalizedName(preset.name))) return;
      state.presets.push({
        id: uuid(),
        default_key: preset.default_key,
        name: preset.name,
        amount_ml: preset.amount_ml,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        dirty: true
      });
    });
    state.defaultsMaterialized = true;
    saveState();
  }

  function editablePreset(id) {
    if (id.startsWith("builtin-")) {
      const original = DEFAULT_PRESETS.find((preset) => preset.id === id);
      materializeDefaultPresets();
      return state.presets.find((preset) => preset.default_key === id)
        || state.presets.find((preset) => normalizedName(preset.name) === normalizedName(original?.name));
    }
    return state.presets.find((preset) => preset.id === id);
  }

  function presetUsageCount(preset) {
    const name = normalizedName(preset?.name);
    return activeEntries().filter((entry) => entry.kind === "drink" && normalizedName(entry.drink_name) === name).length;
  }

  function isNight(value) {
    const date = new Date(value);
    const minute = date.getHours() * 60 + date.getMinutes();
    const [startHour, startMinute] = state.nightStart.split(":").map(Number);
    const [endHour, endMinute] = state.nightEnd.split(":").map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    return start > end ? minute >= start || minute < end : minute >= start && minute < end;
  }

  function statsFor(entries) {
    const intake = entries.filter((item) => item.kind === "drink").reduce((sum, item) => sum + item.amount_ml, 0);
    const output = entries.filter((item) => item.kind === "urination");
    const dayOutput = output.filter((item) => !isNight(item.occurred_at)).reduce((sum, item) => sum + item.amount_ml, 0);
    const nightOutput = output.filter((item) => isNight(item.occurred_at)).reduce((sum, item) => sum + item.amount_ml, 0);
    return { intake, dayOutput, nightOutput, output: dayOutput + nightOutput, visits: output.length, average: output.length ? (dayOutput + nightOutput) / output.length : 0 };
  }

  function entriesForDay(key) {
    return activeEntries().filter((entry) => localDayKey(entry.occurred_at) === key);
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function setKind(kind) {
    entryKind = kind;
    $$(".type-option").forEach((button) => {
      const selected = button.dataset.kind === kind;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-checked", String(selected));
    });
    $("#drink-preset-wrap").hidden = kind !== "drink";
    $("#urgency-wrap").hidden = kind !== "urination";
    $("#amount").placeholder = kind === "drink" ? "250" : "300";
    $(".primary-button[type='submit']").textContent = kind === "drink" ? "Getränk speichern" : "Toilettengang speichern";
    refreshCurrentEntryTime();
  }

  function renderPresets() {
    const presets = activePresets();
    const select = $("#drink-preset");
    const selected = select.value;
    select.innerHTML = presets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`).join("")
      + '<option value="__add__">＋ Neues Getränk hinzufügen …</option>';
    if (presets.some((preset) => preset.id === selected)) select.value = selected;

    $("#preset-list").innerHTML = presets.map((preset) => {
      const usageCount = presetUsageCount(preset);
      const usageLabel = usageCount ? `${usageCount}× verwendet` : "Noch nicht verwendet";
      return `
      <div class="preset-item">
        <div class="preset-copy"><strong>${escapeHtml(preset.name)}</strong><span>${usageLabel}</span></div>
        <div class="preset-actions">
          <button type="button" data-edit-preset="${escapeHtml(preset.id)}" aria-label="${escapeHtml(preset.name)} bearbeiten">Bearbeiten</button>
          <button type="button" data-delete-preset="${escapeHtml(preset.id)}" aria-label="${escapeHtml(preset.name)} löschen" ${usageCount ? `disabled title="Kann nicht gelöscht werden, weil ${escapeHtml(preset.name)} bereits verwendet wurde."` : ""}>Löschen</button>
        </div>
      </div>`;
    }).join("");
  }

  function resetPresetForm(focus = false) {
    $("#preset-form").reset();
    $("#preset-edit-id").value = "";
    $("#preset-form-heading").textContent = "Neues Getränk";
    $("#preset-save-button").textContent = "Hinzufügen";
    $("#preset-cancel-button").hidden = true;
    if (focus) $("#preset-name").focus();
  }

  function openDrinkManagement(createNew = false) {
    navigate("settings");
    $("#drink-settings-card").scrollIntoView({ behavior: "smooth", block: "start" });
    if (createNew) resetPresetForm(true);
  }

  function beginPresetEdit(id) {
    const preset = editablePreset(id);
    if (!preset || preset.deleted_at) return;
    renderPresets();
    $("#preset-edit-id").value = preset.id;
    $("#preset-name").value = preset.name;
    $("#preset-form-heading").textContent = "Getränk bearbeiten";
    $("#preset-save-button").textContent = "Änderungen speichern";
    $("#preset-cancel-button").hidden = false;
    $("#preset-name").focus();
  }

  function deletePreset(id) {
    const visiblePreset = activePresets().find((preset) => preset.id === id);
    if (!visiblePreset) return;
    const usageCount = presetUsageCount(visiblePreset);
    if (usageCount) {
      showToast(`${visiblePreset.name} kann nicht gelöscht werden, weil es bereits verwendet wurde.`);
      return;
    }
    if (!window.confirm(`${visiblePreset.name} wirklich löschen?`)) return;
    const preset = editablePreset(id);
    if (!preset) return;
    const now = new Date().toISOString();
    preset.deleted_at = now;
    preset.updated_at = now;
    preset.dirty = true;
    saveState();
    resetPresetForm();
    renderPresets();
    void syncData();
    showToast("Getränk gelöscht");
  }

  function renderToday() {
    const today = localDayKey(new Date());
    const entries = entriesForDay(today).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
    const stats = statsFor(entries);
    $("#metric-intake").textContent = formatAmount(stats.intake);
    $("#metric-day").textContent = formatAmount(stats.dayOutput);
    $("#metric-night").textContent = formatAmount(stats.nightOutput);
    $("#metric-visits").textContent = String(stats.visits);
    $("#metric-average").textContent = formatAmount(stats.average);
    $("#today-count").textContent = entries.length === 1 ? "1 Eintrag" : `${entries.length} Einträge`;
    const timeline = $("#today-timeline");
    if (!entries.length) {
      timeline.innerHTML = '<div class="empty-state"><strong>Noch keine Einträge</strong>Dein erster Eintrag dauert nur wenige Sekunden.</div>';
      return;
    }
    timeline.innerHTML = entries.map((entry) => {
      const detail = entry.kind === "drink" ? (entry.drink_name || "Getränk") : "Toilettengang";
      const meta = entry.kind === "urination"
        ? [entry.urgency ? `Harndrang: ${urgencyLabel(entry.urgency)}` : "", isNight(entry.occurred_at) ? "Nachtmenge" : "", entry.note || ""].filter(Boolean).join(" · ")
        : (entry.note || "");
      return `<article class="timeline-item">
        <time class="timeline-time">${formatDate(entry.occurred_at, { hour: "2-digit", minute: "2-digit" })}</time>
        <span class="timeline-icon ${entry.kind}" aria-hidden="true">${entry.kind === "drink" ? "+" : "↘"}</span>
        <div class="timeline-copy"><strong>${escapeHtml(detail)}</strong><span>${escapeHtml(meta)}</span></div>
        <div class="timeline-actions"><strong class="timeline-amount">${formatAmount(entry.amount_ml)}</strong><button class="edit-entry-button" type="button" data-edit-entry="${escapeHtml(entry.id)}" aria-label="${escapeHtml(detail)} bearbeiten"><span aria-hidden="true">✎</span> Bearbeiten</button></div>
      </article>`;
    }).join("");
  }

  function dayKeys(count) {
    const keys = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      keys.push(localDayKey(date));
    }
    return keys;
  }

  function renderComparison() {
    const count = Number($("#compare-days").value || 7);
    const rows = dayKeys(count).map((key) => ({ key, stats: statsFor(entriesForDay(key)) }));
    const max = Math.max(1, ...rows.flatMap((row) => [row.stats.intake, row.stats.output]));
    $("#comparison-chart").innerHTML = rows.map(({ key, stats }) => `
      <div class="chart-day" title="${formatDate(dateFromKey(key), { weekday: "long", day: "2-digit", month: "long" })}: ${formatAmount(stats.intake)} getrunken, ${formatAmount(stats.output)} Urin">
        <div class="chart-bars"><span class="bar bar-intake" style="height:${Math.max(stats.intake ? 2 : 0, stats.intake / max * 100)}%"></span><span class="bar bar-output" style="height:${Math.max(stats.output ? 2 : 0, stats.output / max * 100)}%"></span></div>
        <span class="chart-label">${formatDate(dateFromKey(key), { weekday: "short", day: "2-digit" })}</span>
      </div>`).join("");
    $("#comparison-table").innerHTML = [...rows].reverse().map(({ key, stats }) => `<tr><td>${formatDate(dateFromKey(key), { weekday: "short", day: "2-digit", month: "2-digit" })}</td><td>${formatAmount(stats.intake)}</td><td>${formatAmount(stats.output)}</td><td>${stats.visits}</td><td>${formatAmount(stats.average)}</td></tr>`).join("");
  }

  function renderDoctor() {
    const from = $("#doctor-from").value;
    const to = $("#doctor-to").value;
    if (!from || !to) return;
    const entries = activeEntries().filter((entry) => {
      const key = localDayKey(entry.occurred_at);
      return key >= from && key <= to;
    }).sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
    const total = statsFor(entries);
    const dayCount = Math.max(1, Math.round((dateFromKey(to) - dateFromKey(from)) / 86400000) + 1);
    $("#print-period").textContent = `${formatDate(dateFromKey(from), { day: "2-digit", month: "2-digit", year: "numeric" })} bis ${formatDate(dateFromKey(to), { day: "2-digit", month: "2-digit", year: "numeric" })}`;
    $("#doctor-overview").innerHTML = [
      ["Ø Trinkmenge / Tag", formatAmount(total.intake / dayCount)],
      ["Ø Urinmenge / Tag", formatAmount(total.output / dayCount)],
      ["Toilettengänge gesamt", String(total.visits)],
      ["Ø Menge / Gang", formatAmount(total.average)]
    ].map(([label, value]) => `<article class="doctor-stat"><span>${label}</span><strong>${value}</strong></article>`).join("");

    const keys = [];
    const cursor = dateFromKey(from);
    const last = dateFromKey(to);
    while (cursor <= last) {
      keys.push(localDayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    $("#doctor-days").innerHTML = keys.map((key) => {
      const stats = statsFor(entries.filter((entry) => localDayKey(entry.occurred_at) === key));
      return `<tr><td>${formatDate(dateFromKey(key), { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}</td><td>${formatAmount(stats.intake)}</td><td>${formatAmount(stats.dayOutput)}</td><td>${formatAmount(stats.nightOutput)}</td><td>${stats.visits}</td><td>${formatAmount(stats.average)}</td></tr>`;
    }).join("");
    $("#doctor-entries").innerHTML = entries.length ? entries.map((entry) => {
      const details = entry.kind === "drink" ? (entry.drink_name || "–") : (entry.urgency ? `Harndrang: ${urgencyLabel(entry.urgency)}` : "–");
      return `<tr><td>${formatDate(entry.occurred_at, { day: "2-digit", month: "2-digit", year: "numeric" })}</td><td>${formatDate(entry.occurred_at, { hour: "2-digit", minute: "2-digit" })}</td><td>${entry.kind === "drink" ? "Getränk" : "Urinieren"}</td><td>${escapeHtml(details)}</td><td>${formatAmount(entry.amount_ml)}</td><td>${escapeHtml(entry.note || "–")}</td></tr>`;
    }).join("") : '<tr><td colspan="6">Keine Einträge in diesem Zeitraum.</td></tr>';
  }

  function renderSettings() {
    $("#night-start").value = state.nightStart;
    $("#night-end").value = state.nightEnd;
    renderPresets();
    updateAuthUi();
    applyTheme();
  }

  function renderAll() {
    renderToday();
    renderComparison();
    renderDoctor();
    renderSettings();
  }

  function navigate(target) {
    currentView = target;
    $$(".view").forEach((view) => {
      const active = view.dataset.view === target;
      view.hidden = !active;
      view.classList.toggle("active", active);
    });
    $$(".bottom-nav button").forEach((button) => {
      const active = button.dataset.target === target;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    });
    if (target === "compare") renderComparison();
    if (target === "doctor") renderDoctor();
    if (target === "settings") renderSettings();
    if (target === "today") refreshCurrentEntryTime();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function saveEntry(data, existingId = null) {
    const amount = Number(data.amount_ml);
    if (!Number.isFinite(amount) || amount < 1 || amount > 5000) throw new Error("Bitte eine Menge zwischen 1 und 5.000 ml eingeben.");
    const occurredAt = new Date(data.occurred_at || new Date());
    if (Number.isNaN(occurredAt.getTime())) throw new Error("Bitte einen gültigen Zeitpunkt wählen.");
    const existing = existingId ? state.entries.find((item) => item.id === existingId) : null;
    const entry = {
      id: existingId || uuid(),
      kind: data.kind === "urination" ? "urination" : "drink",
      amount_ml: Math.round(amount),
      occurred_at: occurredAt.toISOString(),
      drink_name: data.kind === "drink" ? String(data.drink_name || "Getränk").trim().slice(0, 60) : null,
      urgency: data.kind === "urination" && ["leicht", "mittel", "stark"].includes(data.urgency) ? data.urgency : null,
      note: String(data.note || "").trim().slice(0, 130) || null,
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
      dirty: true
    };
    if (existing) Object.assign(existing, entry); else state.entries.push(entry);
    saveState();
    renderAll();
    void syncData();
    return entry;
  }

  function deleteEntry(id) {
    const entry = state.entries.find((item) => item.id === id);
    if (!entry) return;
    entry.deleted_at = new Date().toISOString();
    entry.updated_at = entry.deleted_at;
    entry.dirty = true;
    saveState();
    renderAll();
    void syncData();
  }

  function openEditDialog(id) {
    const entry = state.entries.find((item) => item.id === id && !item.deleted_at);
    if (!entry) return;
    $("#edit-id").value = entry.id;
    $("#edit-kind").value = entry.kind;
    updateEditFields();
    $("#edit-name").value = entry.drink_name || "";
    $("#edit-amount").value = entry.amount_ml;
    $("#edit-time").value = nowLocalInput(new Date(entry.occurred_at));
    $("#edit-note").value = entry.note || "";
    setRadioValue("edit-urgency", entry.urgency);
    $("#edit-dialog").showModal();
  }

  function updateEditFields() {
    const isUrination = $("#edit-kind").value === "urination";
    $("#edit-name-wrap").hidden = isUrination;
    $("#edit-urgency-wrap").hidden = !isUrination;
  }

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); } catch { return {}; }
  }

  function setSyncStatus(status, label) {
    const button = $("#sync-button");
    button.className = `sync-status ${status || ""}`;
    $("#sync-label").textContent = label;
  }

  async function initSupabase() {
    const config = getConfig();
    if (!config.url || !config.key || !window.supabase?.createClient) {
      setSyncStatus("", config.url ? "Sync nicht verfügbar" : "Nur auf diesem Gerät");
      return false;
    }
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(config.url, config.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      supabaseClient.auth.onAuthStateChange((_event, session) => {
        currentUser = session?.user || null;
        updateAuthUi();
        if (currentUser) setTimeout(() => void syncData(), 0);
      });
    }
    const { data } = await supabaseClient.auth.getSession();
    currentUser = data.session?.user || null;
    updateAuthUi();
    setSyncStatus(currentUser ? "online" : "", currentUser ? "Synchronisiert" : "Nicht angemeldet");
    return true;
  }

  function updateAuthUi() {
    if (!$("#auth-signed-out")) return;
    $("#auth-signed-out").hidden = Boolean(currentUser);
    $("#auth-signed-in").hidden = !currentUser;
    $("#account-email").textContent = currentUser?.email || "";
    const config = getConfig();
    if (!$("#supabase-url").value) $("#supabase-url").value = config.url || "";
    if (!$("#supabase-key").value) $("#supabase-key").value = config.key || "";
  }

  function remoteEntry(entry) {
    return {
      id: entry.id,
      user_id: currentUser.id,
      kind: entry.kind,
      amount_ml: entry.amount_ml,
      occurred_at: entry.occurred_at,
      drink_name: entry.drink_name,
      note: encodedNote(entry),
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      deleted_at: entry.deleted_at
    };
  }

  function remotePreset(preset) {
    return { id: preset.id, user_id: currentUser.id, name: preset.name, amount_ml: preset.amount_ml, created_at: preset.created_at, updated_at: preset.updated_at, deleted_at: preset.deleted_at };
  }

  function mergeRemote(localItems, remoteItems) {
    const map = new Map(localItems.map((item) => [item.id, item]));
    remoteItems.forEach((remote) => {
      const local = map.get(remote.id);
      if (!local || (!local.dirty && new Date(remote.updated_at) >= new Date(local.updated_at))) map.set(remote.id, { ...local, ...remote, dirty: false });
    });
    return [...map.values()];
  }

  async function fetchAllRows(table) {
    const rows = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const result = await supabaseClient.from(table).select("*").order("updated_at", { ascending: true }).range(from, from + pageSize - 1);
      if (result.error) throw result.error;
      rows.push(...(result.data || []));
      if ((result.data || []).length < pageSize) return rows;
    }
  }

  async function syncData() {
    if (syncInProgress || !currentUser || !supabaseClient || !navigator.onLine) return;
    syncInProgress = true;
    setSyncStatus("syncing", "Synchronisiere …");
    try {
      const [remoteEntries, remotePresets] = await Promise.all([
        fetchAllRows("diary_entries"),
        fetchAllRows("drink_presets")
      ]);
      state.entries = mergeRemote(state.entries, remoteEntries.map(normalizeEntry));
      state.presets = mergeRemote(state.presets, remotePresets);

      if (!state.defaultsMaterialized) {
        if (remotePresets.length >= DEFAULT_PRESETS.length) {
          state.defaultsMaterialized = true;
        } else {
          materializeDefaultPresets();
        }
      }

      const dirtyEntries = state.entries.filter((entry) => entry.dirty);
      if (dirtyEntries.length) {
        const { error } = await supabaseClient.from("diary_entries").upsert(dirtyEntries.map(remoteEntry));
        if (error) throw error;
        dirtyEntries.forEach((entry) => { entry.dirty = false; });
      }
      const dirtyPresets = state.presets.filter((preset) => preset.dirty);
      if (dirtyPresets.length) {
        const { error } = await supabaseClient.from("drink_presets").upsert(dirtyPresets.map(remotePreset));
        if (error) throw error;
        dirtyPresets.forEach((preset) => { preset.dirty = false; });
      }
      saveState();
      renderAll();
      setSyncStatus("online", "Synchronisiert");
    } catch (error) {
      console.error(error);
      setSyncStatus("error", "Sync-Fehler");
      $("#auth-message").textContent = `Synchronisation fehlgeschlagen: ${error.message || "Unbekannter Fehler"}`;
    } finally {
      syncInProgress = false;
    }
  }

  async function signIn(createAccount = false) {
    const url = $("#supabase-url").value.trim().replace(/\/$/, "");
    const key = $("#supabase-key").value.trim();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const message = $("#auth-message");
    if (!url || !key || !email || password.length < 8) {
      message.textContent = "Bitte Projekt-URL, Publishable Key, E-Mail und mindestens 8 Passwortzeichen eingeben.";
      return;
    }
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, key }));
    supabaseClient = null;
    message.textContent = createAccount ? "Konto wird angelegt …" : "Anmeldung läuft …";
    try {
      if (!(await initSupabase())) throw new Error("Die Supabase-Bibliothek konnte nicht geladen werden. Bitte die Internetverbindung prüfen.");
      const result = createAccount
        ? await supabaseClient.auth.signUp({ email, password })
        : await supabaseClient.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      currentUser = result.data.session?.user || null;
      message.textContent = result.data.session ? "Angemeldet. Die Daten werden synchronisiert." : "Bitte bestätige die E-Mail und melde dich danach an.";
      updateAuthUi();
      if (currentUser && result.data.session) await syncData();
    } catch (error) {
      message.textContent = `Anmeldung nicht möglich: ${error.message}`;
      setSyncStatus("error", "Anmeldung fehlgeschlagen");
    }
  }

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    try {
      context.registerTool({
        name: "add_diary_entry",
        title: "Tagebucheintrag hinzufügen",
        description: "Speichert ein Getränk oder einen Toilettengang im sichtbaren Blasentagebuch.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["drink", "urination"] },
            amount_ml: { type: "integer", minimum: 1, maximum: 5000 },
            occurred_at: { type: "string", description: "ISO-8601-Zeitpunkt; Standard ist jetzt." },
            drink_name: { type: "string", maxLength: 60 },
            urgency: { type: "string", enum: ["leicht", "mittel", "stark"] },
            note: { type: "string", maxLength: 130 }
          },
          required: ["kind", "amount_ml"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          const entry = saveEntry({ ...input, occurred_at: input.occurred_at || new Date().toISOString() });
          return { id: entry.id, saved: true, kind: entry.kind, amount_ml: entry.amount_ml };
        }
      });
      context.registerTool({
        name: "read_today_summary",
        title: "Heutige Zusammenfassung lesen",
        description: "Liest Trinkmenge, Urinmenge, Toilettengänge und Durchschnittsmenge des heutigen Tages.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute() {
          const stats = statsFor(entriesForDay(localDayKey(new Date())));
          return { intake_ml: stats.intake, urine_day_ml: stats.dayOutput, urine_night_ml: stats.nightOutput, visits: stats.visits, average_ml: Math.round(stats.average) };
        }
      });
    } catch (error) {
      console.info("WebMCP ist in diesem Browser nicht verfügbar.", error);
    }
  }

  function bindEvents() {
    $$(".type-option").forEach((button) => button.addEventListener("click", () => setKind(button.dataset.kind)));
    $$(".quick-amounts button").forEach((button) => button.addEventListener("click", () => { $("#amount").value = button.dataset.amount; updateQuickAmountSelection(); }));
    $("#amount").addEventListener("input", updateQuickAmountSelection);
    $("#drink-preset").addEventListener("change", (event) => {
      if (event.target.value === "__add__") {
        openDrinkManagement(true);
        return;
      }
    });
    $("#manage-drinks-button").addEventListener("click", () => openDrinkManagement(false));
    $("#occurred-at").addEventListener("input", () => {
      occurredAtManuallySet = true;
      $("#use-current-time").hidden = false;
      updateEntryTimeSummary();
    });
    $("#use-current-time").addEventListener("click", () => refreshCurrentEntryTime(true));
    $("#entry-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const error = $("#form-error");
      error.textContent = "";
      try {
        refreshCurrentEntryTime();
        const preset = activePresets().find((item) => item.id === $("#drink-preset").value);
        if (entryKind === "drink" && !preset) throw new Error("Bitte zuerst ein Getränk anlegen oder auswählen.");
        const urgency = selectedRadioValue("urgency");
        if (entryKind === "urination" && !urgency) throw new Error("Bitte den Harndrang auswählen: leicht, mittel oder stark.");
        saveEntry({ kind: entryKind, amount_ml: $("#amount").value, occurred_at: $("#occurred-at").value, drink_name: preset?.name, urgency, note: $("#note").value });
        showToast(entryKind === "drink" ? "Getränk gespeichert" : "Toilettengang gespeichert");
        $("#amount").value = "";
        updateQuickAmountSelection();
        setRadioValue("urgency", null);
        $("#note").value = "";
        refreshCurrentEntryTime(true);
      } catch (exception) { error.textContent = exception.message; }
    });
    $$(".bottom-nav button").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.target)));
    $("#go-all-entries").addEventListener("click", () => { $("#compare-days").value = "30"; navigate("compare"); });
    $("#sync-button").addEventListener("click", () => navigate("settings"));
    $("#comparison-days")?.addEventListener("change", renderComparison);
    $("#compare-days").addEventListener("change", renderComparison);
    $("#today-timeline").addEventListener("click", (event) => {
      const button = event.target.closest("[data-edit-entry]");
      if (button) openEditDialog(button.dataset.editEntry);
    });
    $("#edit-form").addEventListener("submit", (event) => {
      if (event.submitter?.value !== "save") return;
      event.preventDefault();
      try {
        const editUrgency = selectedRadioValue("edit-urgency");
        if ($("#edit-kind").value === "urination" && !editUrgency) throw new Error("Bitte den Harndrang auswählen: leicht, mittel oder stark.");
        saveEntry({ kind: $("#edit-kind").value, drink_name: $("#edit-name").value, amount_ml: $("#edit-amount").value, occurred_at: $("#edit-time").value, urgency: editUrgency, note: $("#edit-note").value }, $("#edit-id").value);
        $("#edit-dialog").close();
        showToast("Eintrag aktualisiert");
      } catch (error) { showToast(error.message); }
    });
    $("#edit-kind").addEventListener("change", updateEditFields);
    $("#delete-entry-button").addEventListener("click", () => {
      if (!window.confirm("Diesen Eintrag wirklich löschen?")) return;
      deleteEntry($("#edit-id").value);
      $("#edit-dialog").close();
      showToast("Eintrag gelöscht");
    });
    ["#doctor-from", "#doctor-to"].forEach((id) => $(id).addEventListener("change", renderDoctor));
    $("#print-button").addEventListener("click", () => window.print());
    $("#night-start").addEventListener("change", (event) => { state.nightStart = event.target.value; saveState(); renderAll(); });
    $("#night-end").addEventListener("change", (event) => { state.nightEnd = event.target.value; saveState(); renderAll(); });
    $$('[data-theme-mode]').forEach((button) => button.addEventListener("click", () => setThemeMode(button.dataset.themeMode)));
    $("#theme-toggle").addEventListener("click", () => setThemeMode(resolvedTheme() === "dark" ? "light" : "dark"));
    $("#preset-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const name = $("#preset-name").value.trim();
      const editId = $("#preset-edit-id").value;
      if (!name) {
        showToast("Bitte einen Namen für das Getränk eingeben.");
        return;
      }
      const duplicate = activePresets().find((preset) => preset.id !== editId && normalizedName(preset.name) === normalizedName(name));
      if (duplicate) {
        showToast("Ein Getränk mit diesem Namen gibt es bereits.");
        return;
      }
      const now = new Date().toISOString();
      if (editId) {
        const preset = state.presets.find((item) => item.id === editId);
        if (!preset) return;
        const oldName = preset.name;
        preset.name = name.slice(0, 40);
        preset.updated_at = now;
        preset.dirty = true;
        state.entries.forEach((entry) => {
          if (!entry.deleted_at && entry.kind === "drink" && normalizedName(entry.drink_name) === normalizedName(oldName)) {
            entry.drink_name = preset.name;
            entry.updated_at = now;
            entry.dirty = true;
          }
        });
        showToast("Getränk aktualisiert");
      } else {
        state.presets.push({ id: uuid(), name: name.slice(0, 40), amount_ml: 250, created_at: now, updated_at: now, deleted_at: null, dirty: true });
        showToast("Getränk hinzugefügt");
      }
      saveState();
      resetPresetForm();
      renderAll();
      void syncData();
    });
    $("#preset-list").addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-edit-preset]");
      if (editButton) { beginPresetEdit(editButton.dataset.editPreset); return; }
      const deleteButton = event.target.closest("[data-delete-preset]");
      if (deleteButton) deletePreset(deleteButton.dataset.deletePreset);
    });
    $("#preset-cancel-button").addEventListener("click", () => resetPresetForm());
    $("#auth-signed-out").addEventListener("submit", (event) => { event.preventDefault(); void signIn(false); });
    $("#sign-up-button").addEventListener("click", () => void signIn(true));
    $("#sync-now-button").addEventListener("click", () => void syncData());
    $("#sign-out-button").addEventListener("click", async () => { await supabaseClient?.auth.signOut(); currentUser = null; updateAuthUi(); setSyncStatus("", "Nicht angemeldet"); });
    $("#export-button").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), ...state }, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob); link.download = `blasentagebuch-${localDayKey(new Date())}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 500);
    });
    $("#clear-button").addEventListener("click", () => {
      if (!window.confirm("Alle lokalen Einträge und eigenen Standardgetränke auf diesem Gerät löschen?")) return;
      state = freshState();
      occurredAtManuallySet = false;
      saveState();
      applyTheme();
      refreshCurrentEntryTime(true);
      renderAll();
      showToast("Lokale Daten gelöscht");
    });
    window.addEventListener("online", () => void syncData());
    window.addEventListener("offline", () => setSyncStatus("", "Offline – lokal gespeichert"));
    window.addEventListener("focus", () => refreshCurrentEntryTime());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshCurrentEntryTime(); });
    const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => { if (state.themeMode === "auto") applyTheme(); };
    if (themeMedia.addEventListener) themeMedia.addEventListener("change", handleSystemThemeChange);
    else themeMedia.addListener(handleSystemThemeChange);
    window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); installPrompt = event; $("#install-button").classList.remove("hidden"); });
    $("#install-button").addEventListener("click", async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $("#install-button").classList.add("hidden"); });
  }

  async function init() {
    applyTheme();
    $("#today-label").textContent = formatDate(new Date(), { weekday: "long", day: "2-digit", month: "long" });
    refreshCurrentEntryTime(true);
    const today = new Date();
    const from = new Date(today); from.setDate(today.getDate() - 6);
    $("#doctor-from").value = localDayKey(from);
    $("#doctor-to").value = localDayKey(today);
    renderPresets();
    setKind("drink");
    bindEvents();
    renderAll();
    window.setInterval(() => { if (document.visibilityState === "visible") refreshCurrentEntryTime(); }, 15000);
    registerWebMcpTools();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
    try { await initSupabase(); if (currentUser) await syncData(); } catch (error) { console.error(error); setSyncStatus("error", "Sync nicht verfügbar"); }
  }

  init();
})();
