(() => {
  "use strict";

  const STORAGE_KEY = "blasentagebuch.state.v1";
  const CONFIG_KEY = "blasentagebuch.supabase.v1";
  const URGENCY_MARKER = /^\[\[harndrang:(leicht|mittel|stark)\]\]\s*/i;
  const DEFAULT_NIGHT_START = "22:00";
  const DEFAULT_NIGHT_END = "06:00";
  const DEFAULT_QUICK_AMOUNTS = [100, 250, 320, 430, 500, 1000];
  const MEAL_TAG_LABELS = { prepared: "Fertiggericht", salty: "Salzig", water_rich: "Wasserreich", large_portion: "Große Portion" };
  const DAILY_TAG_LABELS = { cold: "Kältegefühl", kidney_belt: "Nierengurt", sport: "Sport", sweating: "Stark geschwitzt", stress: "Stress" };
  const DEFAULT_PRESETS = [
    { id: "builtin-water", default_key: "builtin-water", name: "Wasser", amount_ml: 250, builtIn: true },
    { id: "builtin-coffee", default_key: "builtin-coffee", name: "Kaffee", amount_ml: 200, builtIn: true },
    { id: "builtin-tea", default_key: "builtin-tea", name: "Tee", amount_ml: 250, builtIn: true },
    { id: "builtin-juice", default_key: "builtin-juice", name: "Saft", amount_ml: 200, builtIn: true }
  ];

  const freshState = () => ({
    entries: [],
    presets: [],
    sleepEvents: [],
    dailyContexts: [],
    defaultsMaterialized: false,
    nightStart: DEFAULT_NIGHT_START,
    nightEnd: DEFAULT_NIGHT_END,
    nightSettingsUpdatedAt: null,
    nightSettingsDirty: false,
    themeMode: "auto"
  });
  let state = loadState();
  let entryKind = "drink";
  let currentView = "today";
  let supabaseClient = null;
  let currentUser = null;
  let syncInProgress = false;
  let installPrompt = null;
  let toastTimer = null;
  let occurredAtManuallySet = false;
  let nightSettingsSyncAvailable = null;
  let sleepEventsSyncAvailable = null;
  let extendedDiarySyncAvailable = null;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const loaded = {
        ...freshState(),
        ...saved,
        entries: (saved.entries || []).map(normalizeEntry),
        sleepEvents: saved.sleepEvents || [],
        dailyContexts: saved.dailyContexts || []
      };
      loaded.nightStart = normalizeTimeValue(loaded.nightStart, DEFAULT_NIGHT_START);
      loaded.nightEnd = normalizeTimeValue(loaded.nightEnd, DEFAULT_NIGHT_END);
      const customizedLegacySetting = loaded.nightStart !== DEFAULT_NIGHT_START || loaded.nightEnd !== DEFAULT_NIGHT_END;
      if (!loaded.nightSettingsUpdatedAt && customizedLegacySetting) {
        loaded.nightSettingsUpdatedAt = new Date().toISOString();
        loaded.nightSettingsDirty = true;
      }
      return loaded;
    } catch {
      return freshState();
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function normalizeTimeValue(value, fallback) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})/);
    if (!match) return fallback;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour < 24 && minute < 60 ? `${match[1]}:${match[2]}` : fallback;
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

  function setSplitDateTime(dateSelector, timeSelector, date = new Date()) {
    const value = nowLocalInput(date);
    $(dateSelector).value = value.slice(0, 10);
    $(timeSelector).value = value.slice(11, 16);
  }

  function combinedDateTime(dateSelector, timeSelector) {
    const date = $(dateSelector).value;
    const time = $(timeSelector).value;
    return date && time ? `${date}T${time}` : "";
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
    const value = combinedDateTime("#occurred-date", "#occurred-time");
    if (!value) return;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return;
    const time = formatDate(date, { hour: "2-digit", minute: "2-digit" });
    const differentDay = localDayKey(date) !== localDayKey(new Date());
    const datePart = differentDay ? `${formatDate(date, { day: "2-digit", month: "2-digit" })} · ` : "";
    $("#entry-time-summary").textContent = `${occurredAtManuallySet ? "Geändert" : "Jetzt"} · ${datePart}${time} Uhr`;
  }

  function refreshCurrentEntryTime(force = false) {
    if (occurredAtManuallySet && !force) return;
    setSplitDateTime("#occurred-date", "#occurred-time");
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

  function formatPercent(value) {
    return value === null || !Number.isFinite(value) ? "–" : `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value)} %`;
  }

  function formatCount(value) {
    return new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value || 0);
  }

  function normalizeEntry(entry) {
    const base = { ...entry, meal_name: entry.meal_name || null, tags: Array.isArray(entry.tags) ? entry.tags : [] };
    if (entry.kind !== "urination") return { ...base, urgency: null };
    const note = String(entry.note || "");
    const match = note.match(URGENCY_MARKER);
    return {
      ...base,
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

  function selectedCheckboxValues(name) {
    return $$(`input[name="${name}"]:checked`).map((input) => input.value);
  }

  function setCheckboxValues(name, values = []) {
    const selected = new Set(values);
    $$(`input[name="${name}"]`).forEach((input) => { input.checked = selected.has(input.value); });
  }

  function updateQuickAmountSelection() {
    const amount = String(Number($("#amount").value || 0));
    $$(".quick-amounts button").forEach((button) => {
      const selected = amount !== "0" && button.dataset.amount === amount;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function quickAmountOptions(kind = entryKind) {
    const frequency = new Map();
    activeEntries().filter((entry) => entry.kind === kind).forEach((entry) => {
      const amount = Number(entry.amount_ml);
      if (!Number.isFinite(amount) || amount < 1) return;
      const previous = frequency.get(amount) || { amount, count: 0, lastUsed: 0 };
      previous.count += 1;
      previous.lastUsed = Math.max(previous.lastUsed, new Date(entry.occurred_at).getTime() || 0);
      frequency.set(amount, previous);
    });
    const options = [...frequency.values()].sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed || a.amount - b.amount);
    DEFAULT_QUICK_AMOUNTS.forEach((amount) => {
      if (!frequency.has(amount)) options.push({ amount, count: 0, lastUsed: 0 });
    });
    return options.slice(0, 6);
  }

  function renderQuickAmounts() {
    $(".quick-amounts").innerHTML = quickAmountOptions().map(({ amount, count }) => {
      const usage = count ? `${count}× bisher verwendet` : "Standardwert";
      return `<button type="button" data-amount="${amount}" title="${usage}" aria-label="${amount} Milliliter, ${usage}">${amount}</button>`;
    }).join("");
    updateQuickAmountSelection();
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function activeEntries() {
    return state.entries.filter((entry) => !entry.deleted_at);
  }

  function activeDailyContexts() {
    return state.dailyContexts.filter((context) => !context.deleted_at);
  }

  function contextForDay(dayKey) {
    return activeDailyContexts().find((context) => context.day_key === dayKey) || null;
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

  function activeSleepEvents() {
    return state.sleepEvents
      .filter((event) => !event.deleted_at)
      .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  }

  function shiftDayKey(key, days) {
    const date = dateFromKey(key);
    date.setDate(date.getDate() + days);
    return localDayKey(date);
  }

  function clockNightInfo(value) {
    const date = new Date(value);
    const minute = date.getHours() * 60 + date.getMinutes();
    const [startHour, startMinute] = normalizeTimeValue(state.nightStart, DEFAULT_NIGHT_START).split(":").map(Number);
    const [endHour, endMinute] = normalizeTimeValue(state.nightEnd, DEFAULT_NIGHT_END).split(":").map(Number);
    const start = startHour * 60 + startMinute;
    const end = endHour * 60 + endMinute;
    const wrapsMidnight = start > end;
    const night = wrapsMidnight ? minute >= start || minute < end : minute >= start && minute < end;
    return { night, afterMidnight: night && wrapsMidnight && minute < end };
  }

  function fallbackClassification(value) {
    const date = new Date(value);
    const clock = clockNightInfo(date);
    const calendarDay = localDayKey(date);
    return {
      phase: clock.night ? "night" : "day",
      dayKey: clock.afterMidnight ? shiftDayKey(calendarDay, -1) : calendarDay,
      morningVoid: false,
      source: "fallback"
    };
  }

  function classifyEntry(entry) {
    const occurredAt = new Date(entry.occurred_at);
    const timestamp = occurredAt.getTime();
    const events = activeSleepEvents();
    const latestEvent = [...events].reverse().find((event) => new Date(event.occurred_at).getTime() <= timestamp);
    if (!latestEvent) return fallbackClassification(occurredAt);

    const latestEventTime = new Date(latestEvent.occurred_at).getTime();
    const earlierWakes = events.filter((event) => event.kind === "wake_up" && new Date(event.occurred_at).getTime() < latestEventTime);
    const latestEarlierWake = earlierWakes.at(-1);

    if (latestEvent.kind === "sleep_start") {
      const dayKey = latestEarlierWake
        ? localDayKey(latestEarlierWake.occurred_at)
        : fallbackClassification(latestEvent.occurred_at).dayKey;
      return { phase: "night", dayKey, morningVoid: false, source: "event" };
    }

    const wakeDayKey = localDayKey(latestEvent.occurred_at);
    const nextSleep = events.find((event) => event.kind === "sleep_start" && new Date(event.occurred_at).getTime() > latestEventTime);
    const nextSleepTime = nextSleep ? new Date(nextSleep.occurred_at).getTime() : Number.POSITIVE_INFINITY;
    const firstUrinationAfterWake = activeEntries()
      .filter((item) => item.kind === "urination" && new Date(item.occurred_at).getTime() >= latestEventTime && new Date(item.occurred_at).getTime() < nextSleepTime)
      .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at))[0];
    const morningVoid = entry.kind === "urination" && firstUrinationAfterWake?.id === entry.id;
    if (!morningVoid) return { phase: "day", dayKey: wakeDayKey, morningVoid: false, source: "event" };

    const previousWake = events
      .filter((event) => event.kind === "wake_up" && new Date(event.occurred_at).getTime() < latestEventTime)
      .at(-1);
    return {
      phase: "night",
      dayKey: previousWake ? localDayKey(previousWake.occurred_at) : shiftDayKey(wakeDayKey, -1),
      morningVoid: true,
      source: "event"
    };
  }

  function currentDiaryDayKey(date = new Date()) {
    const probe = { id: "current-time", kind: "drink", occurred_at: date.toISOString() };
    return classifyEntry(probe).dayKey;
  }

  function currentPhaseStatus(date = new Date()) {
    const timestamp = date.getTime();
    const events = activeSleepEvents().filter((event) => new Date(event.occurred_at).getTime() <= timestamp);
    const latestEvent = events.at(-1);
    if (!latestEvent) {
      return { phase: clockNightInfo(date).night ? "night" : "day", pendingMorningVoid: false, source: "fallback", since: null };
    }
    if (latestEvent.kind === "sleep_start") return { phase: "night", pendingMorningVoid: false, source: "event", since: latestEvent.occurred_at };
    const nextSleep = activeSleepEvents().find((event) => event.kind === "sleep_start" && new Date(event.occurred_at).getTime() > new Date(latestEvent.occurred_at).getTime());
    const nextSleepTime = nextSleep ? new Date(nextSleep.occurred_at).getTime() : Number.POSITIVE_INFINITY;
    const morningVoidRecorded = activeEntries().some((entry) => entry.kind === "urination"
      && new Date(entry.occurred_at).getTime() >= new Date(latestEvent.occurred_at).getTime()
      && new Date(entry.occurred_at).getTime() < nextSleepTime);
    return { phase: "day", pendingMorningVoid: !morningVoidRecorded, source: "event", since: latestEvent.occurred_at };
  }

  function sleepStartForDay(dayKey) {
    const event = activeSleepEvents().filter((item) => item.kind === "sleep_start"
      && classifyEntry({ id: `sleep-${item.id}`, kind: "meal", occurred_at: item.occurred_at }).dayKey === dayKey).at(-1);
    if (event) return new Date(event.occurred_at);
    const fallback = dateFromKey(dayKey);
    const [hour, minute] = normalizeTimeValue(state.nightStart, DEFAULT_NIGHT_START).split(":").map(Number);
    fallback.setHours(hour, minute, 0, 0);
    return fallback;
  }

  function statsFor(entries, dayKey = null) {
    const drinks = entries.filter((item) => item.kind === "drink");
    const intake = drinks.reduce((sum, item) => sum + Number(item.amount_ml || 0), 0);
    const after20 = drinks.filter((item) => new Date(item.occurred_at).getHours() >= 20).reduce((sum, item) => sum + Number(item.amount_ml || 0), 0);
    const beforeSleep = drinks.filter((item) => {
      const sleepStart = sleepStartForDay(dayKey || classifyEntry(item).dayKey).getTime();
      const occurredAt = new Date(item.occurred_at).getTime();
      return occurredAt <= sleepStart && occurredAt >= sleepStart - 3 * 60 * 60 * 1000;
    }).reduce((sum, item) => sum + Number(item.amount_ml || 0), 0);
    const output = entries.filter((item) => item.kind === "urination");
    const dayItems = output.filter((item) => classifyEntry(item).phase === "day");
    const dayOutput = dayItems.reduce((sum, item) => sum + Number(item.amount_ml || 0), 0);
    const nightOutput = output.filter((item) => classifyEntry(item).phase === "night").reduce((sum, item) => sum + Number(item.amount_ml || 0), 0);
    const nightVisits = output.filter((item) => {
      const classification = classifyEntry(item);
      return classification.phase === "night" && !classification.morningVoid;
    }).length;
    const totalOutput = dayOutput + nightOutput;
    const urgency = Object.fromEntries(["leicht", "mittel", "stark"].map((level) => {
      const items = output.filter((item) => item.urgency === level);
      const amount = items.reduce((sum, item) => sum + Number(item.amount_ml || 0), 0);
      return [level, { count: items.length, average: items.length ? amount / items.length : 0 }];
    }));
    return {
      intake,
      after20,
      beforeSleep,
      dayOutput,
      nightOutput,
      output: totalOutput,
      nightShare: totalOutput ? nightOutput / totalOutput * 100 : null,
      visits: output.length,
      dayVisits: dayItems.length,
      nightVisits,
      average: output.length ? totalOutput / output.length : 0,
      maximum: Math.max(0, ...output.map((item) => Number(item.amount_ml || 0))),
      urgency
    };
  }

  function entriesForDay(key) {
    return activeEntries().filter((entry) => classifyEntry(entry).dayKey === key);
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
    $("#meal-fields").hidden = kind !== "meal";
    $("#amount-row").hidden = kind === "meal";
    $("#urgency-wrap").hidden = kind !== "urination";
    $("#amount").placeholder = kind === "drink" ? "250" : "300";
    $("#entry-form .primary-button[type='submit']").textContent = kind === "drink" ? "Getränk speichern" : (kind === "urination" ? "Toilettengang speichern" : "Mahlzeit speichern");
    if (kind !== "meal") renderQuickAmounts();
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

  function renderPhaseControl() {
    const status = currentPhaseStatus();
    const phaseLabel = status.phase === "night" ? "Schlafphase" : "Tagphase";
    const since = status.since ? ` seit ${formatDate(status.since, { hour: "2-digit", minute: "2-digit" })} Uhr` : "";
    $("#phase-label").textContent = `${phaseLabel}${since}`;
    $("#wake-up-button").hidden = status.phase !== "night";
    $("#sleep-start-button").hidden = status.phase !== "day";
    $("#phase-control").classList.toggle("night", status.phase === "night");
    if (status.pendingMorningVoid) {
      $("#phase-help").textContent = "Der nächste Toilettengang wird als Morgenurin der vergangenen Nacht zugeordnet.";
    } else if (status.source === "fallback") {
      $("#phase-help").textContent = `Automatisch nach der Ersatz-Nachtzeit ${state.nightStart}–${state.nightEnd} Uhr. Tippe beim Schlafengehen oder Aufstehen für eine genaue Auswertung.`;
    } else {
      $("#phase-help").textContent = status.phase === "night"
        ? "Nächtliche Toilettengänge zählen zu diesem Messtag."
        : "Beim Aufstehen wird der nächste Toilettengang automatisch als Morgenurin erkannt.";
    }
  }

  function renderDailyContext(dayKey = $("#daily-context-day").value || currentDiaryDayKey()) {
    if (!$("#daily-context-day").value) $("#daily-context-day").value = dayKey;
    const context = contextForDay(dayKey);
    setCheckboxValues("daily-tags", context?.tags || []);
    $("#daily-note").value = context?.note || "";
    if (!currentUser) {
      $("#daily-context-status").textContent = "Auf diesem Gerät";
    } else if (extendedDiarySyncAvailable === false) {
      $("#daily-context-status").textContent = "Datenbank-Update nötig";
    } else if (context?.dirty) {
      $("#daily-context-status").textContent = "Wird synchronisiert …";
    } else if (extendedDiarySyncAvailable === null) {
      $("#daily-context-status").textContent = "Synchronisation wird geprüft …";
    } else {
      $("#daily-context-status").textContent = "Synchronisiert";
    }
  }

  function saveDailyContext(dayKey, tags, note) {
    const existing = state.dailyContexts.find((context) => context.day_key === dayKey && !context.deleted_at);
    const now = new Date().toISOString();
    const context = {
      id: existing?.id || uuid(),
      day_key: dayKey,
      tags: tags.filter((tag) => DAILY_TAG_LABELS[tag]),
      note: String(note || "").trim().slice(0, 500) || null,
      created_at: existing?.created_at || now,
      updated_at: now,
      deleted_at: null,
      dirty: true
    };
    if (existing) Object.assign(existing, context); else state.dailyContexts.push(context);
    saveState();
    renderAll();
    void syncData();
  }

  function renderToday() {
    const today = currentDiaryDayKey();
    const entries = entriesForDay(today).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
    const stats = statsFor(entries, today);
    renderPhaseControl();
    renderDailyContext();
    $("#summary-heading").textContent = `Messtag ${formatDate(dateFromKey(today), { day: "2-digit", month: "2-digit" })}`;
    $("#metric-intake").textContent = formatAmount(stats.intake);
    $("#metric-after-20").textContent = formatAmount(stats.after20);
    $("#metric-before-sleep").textContent = formatAmount(stats.beforeSleep);
    $("#metric-day").textContent = formatAmount(stats.dayOutput);
    $("#metric-night").textContent = formatAmount(stats.nightOutput);
    $("#metric-night-share").textContent = formatPercent(stats.nightShare);
    $("#metric-visits").textContent = String(stats.visits);
    $("#metric-average").textContent = formatAmount(stats.average);
    $("#metric-maximum").textContent = formatAmount(stats.maximum);
    $("#today-count").textContent = entries.length === 1 ? "1 Eintrag" : `${entries.length} Einträge`;
    const timeline = $("#today-timeline");
    if (!entries.length) {
      timeline.innerHTML = '<div class="empty-state"><strong>Noch keine Einträge</strong>Dein erster Eintrag dauert nur wenige Sekunden.</div>';
      return;
    }
    timeline.innerHTML = entries.map((entry) => {
      const detail = entry.kind === "drink" ? (entry.drink_name || "Getränk") : (entry.kind === "meal" ? (entry.meal_name || "Mahlzeit") : "Toilettengang");
      const classification = classifyEntry(entry);
      const phaseLabel = classification.morningVoid ? "Morgenurin · Nachtmenge" : (classification.phase === "night" ? "Nachtmenge" : "Tagmenge");
      const meta = entry.kind === "urination"
        ? [phaseLabel, entry.urgency ? `Harndrang: ${urgencyLabel(entry.urgency)}` : "", entry.note || ""].filter(Boolean).join(" · ")
        : (entry.kind === "meal" ? [...entry.tags.map((tag) => MEAL_TAG_LABELS[tag]).filter(Boolean), entry.note || ""].filter(Boolean).join(" · ") : (entry.note || ""));
      const icon = entry.kind === "drink" ? "+" : (entry.kind === "meal" ? "⌁" : "↘");
      const amount = entry.kind === "meal" ? "" : `<strong class="timeline-amount">${formatAmount(entry.amount_ml)}</strong>`;
      return `<article class="timeline-item">
        <time class="timeline-time">${formatDate(entry.occurred_at, { hour: "2-digit", minute: "2-digit" })}</time>
        <span class="timeline-icon ${entry.kind}" aria-hidden="true">${icon}</span>
        <div class="timeline-copy"><strong>${escapeHtml(detail)}</strong><span>${escapeHtml(meta)}</span></div>
        <div class="timeline-actions">${amount}<button class="edit-entry-button" type="button" data-edit-entry="${escapeHtml(entry.id)}" aria-label="${escapeHtml(detail)} bearbeiten"><span aria-hidden="true">✎</span> Bearbeiten</button></div>
      </article>`;
    }).join("");
  }

  function dayKeys(count) {
    const keys = [];
    const today = dateFromKey(currentDiaryDayKey());
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
    const rows = dayKeys(count).map((key) => ({ key, stats: statsFor(entriesForDay(key), key) }));
    const max = Math.max(1, ...rows.flatMap((row) => [row.stats.intake, row.stats.output]));
    $("#comparison-chart").innerHTML = rows.map(({ key, stats }) => `
      <div class="chart-day" title="${formatDate(dateFromKey(key), { weekday: "long", day: "2-digit", month: "long" })}: ${formatAmount(stats.intake)} getrunken, ${formatAmount(stats.dayOutput)} Urin Tag, ${formatAmount(stats.nightOutput)} Urin Nacht">
        <div class="chart-bars"><span class="bar bar-intake" style="height:${Math.max(stats.intake ? 2 : 0, stats.intake / max * 100)}%"></span><span class="bar bar-output" style="height:${Math.max(stats.output ? 2 : 0, stats.output / max * 100)}%"></span></div>
        <span class="chart-label">${formatDate(dateFromKey(key), { weekday: "short", day: "2-digit" })}</span>
      </div>`).join("");
    $("#comparison-table").innerHTML = [...rows].reverse().map(({ key, stats }) => `<tr><td>${formatDate(dateFromKey(key), { weekday: "short", day: "2-digit", month: "2-digit" })}</td><td>${formatAmount(stats.intake)}</td><td>${formatAmount(stats.after20)}</td><td>${formatAmount(stats.beforeSleep)}</td><td>${formatAmount(stats.dayOutput)}</td><td>${formatAmount(stats.nightOutput)}</td><td>${formatPercent(stats.nightShare)}</td><td>${stats.dayVisits}/${stats.nightVisits}</td><td>${formatAmount(stats.average)}</td><td>${formatAmount(stats.maximum)}</td></tr>`).join("");
  }

  function renderDoctor() {
    const from = $("#doctor-from").value;
    const to = $("#doctor-to").value;
    if (!from || !to) return;
    const entries = activeEntries().filter((entry) => {
      const key = classifyEntry(entry).dayKey;
      return key >= from && key <= to;
    }).sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
    const total = statsFor(entries);
    const dayCount = Math.max(1, Math.round((dateFromKey(to) - dateFromKey(from)) / 86400000) + 1);
    $("#print-period").textContent = `${formatDate(dateFromKey(from), { day: "2-digit", month: "2-digit", year: "numeric" })} bis ${formatDate(dateFromKey(to), { day: "2-digit", month: "2-digit", year: "numeric" })}`;
    $("#print-night-period").textContent = `Nachtmenge inklusive Morgenurin; nächtliche Gänge ohne Morgenurin. Ersatz-Nachtzeit für Tage ohne Schlafdaten: ${state.nightStart} bis ${state.nightEnd} Uhr.`;
    $("#doctor-overview").innerHTML = [
      ["Ø Trinken / 24 h", formatAmount(total.intake / dayCount)],
      ["Ø Urin / 24 h", formatAmount(total.output / dayCount)],
      ["Ø Nachturin / 24 h", formatAmount(total.nightOutput / dayCount)],
      ["Nachtanteil im Zeitraum", formatPercent(total.nightShare)],
      ["Ø Gänge Tag / Nacht je 24 h", `${formatCount(total.dayVisits / dayCount)} / ${formatCount(total.nightVisits / dayCount)}`],
      ["Ø Entleerung / Gang", formatAmount(total.average)],
      ["Max. Entleerung im Zeitraum", formatAmount(total.maximum)],
      ["Ø nach 20 h / 24 h", formatAmount(total.after20 / dayCount)],
      ["Ø in 3 h vor Schlaf / 24 h", formatAmount(total.beforeSleep / dayCount)]
    ].map(([label, value]) => `<article class="doctor-stat"><span>${label}</span><strong>${value}</strong></article>`).join("");

    const keys = [];
    const cursor = dateFromKey(from);
    const last = dateFromKey(to);
    while (cursor <= last) {
      keys.push(localDayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    $("#doctor-days").innerHTML = keys.map((key) => {
      const stats = statsFor(entries.filter((entry) => classifyEntry(entry).dayKey === key), key);
      return `<tr><td>${formatDate(dateFromKey(key), { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}</td><td>${formatAmount(stats.intake)}</td><td>${formatAmount(stats.after20)}</td><td>${formatAmount(stats.beforeSleep)}</td><td>${formatAmount(stats.dayOutput)}</td><td>${formatAmount(stats.nightOutput)}</td><td>${formatPercent(stats.nightShare)}</td><td>${stats.dayVisits}/${stats.nightVisits}</td><td>${formatAmount(stats.average)}</td><td>${formatAmount(stats.maximum)}</td></tr>`;
    }).join("");
    $("#doctor-urgency").innerHTML = ["leicht", "mittel", "stark"].map((level) => {
      const item = total.urgency[level];
      return `<article class="urgency-stat"><span>${urgencyLabel(level)}</span><strong>${item.count}× · Ø ${formatAmount(item.average)}</strong></article>`;
    }).join("");
    const contexts = activeDailyContexts().filter((context) => context.day_key >= from && context.day_key <= to && (context.note || context.tags.length));
    $("#doctor-contexts").innerHTML = contexts.length ? contexts.sort((a, b) => a.day_key.localeCompare(b.day_key)).map((context) => `
      <tr><td>${formatDate(dateFromKey(context.day_key), { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}</td><td>${escapeHtml(context.tags.map((tag) => DAILY_TAG_LABELS[tag]).filter(Boolean).join(", ") || "–")}</td><td>${escapeHtml(context.note || "–")}</td></tr>`).join("") : '<tr><td colspan="3">Keine Tagesfaktoren oder Tagesnotizen in diesem Zeitraum.</td></tr>';
    $("#doctor-entries").innerHTML = entries.length ? entries.map((entry) => {
      const classification = classifyEntry(entry);
      const details = entry.kind === "drink"
        ? (entry.drink_name || "–")
        : (entry.kind === "meal"
          ? [entry.meal_name || "Mahlzeit", ...entry.tags.map((tag) => MEAL_TAG_LABELS[tag]).filter(Boolean)].join(" · ")
          : [classification.morningVoid ? "Morgenurin" : (classification.phase === "night" ? "Nachtmenge" : "Tagmenge"), `Messtag ${formatDate(dateFromKey(classification.dayKey), { day: "2-digit", month: "2-digit" })}`, entry.urgency ? `Harndrang: ${urgencyLabel(entry.urgency)}` : ""].filter(Boolean).join(" · "));
      const kind = entry.kind === "drink" ? "Getränk" : (entry.kind === "meal" ? "Mahlzeit" : "Urinieren");
      return `<tr><td>${formatDate(entry.occurred_at, { day: "2-digit", month: "2-digit", year: "numeric" })}</td><td>${formatDate(entry.occurred_at, { hour: "2-digit", minute: "2-digit" })}</td><td>${kind}</td><td>${escapeHtml(details)}</td><td>${entry.kind === "meal" ? "–" : formatAmount(entry.amount_ml)}</td><td>${escapeHtml(entry.note || "–")}</td></tr>`;
    }).join("") : '<tr><td colspan="6">Keine Einträge in diesem Zeitraum.</td></tr>';
  }

  function renderSettings() {
    $("#night-start").value = state.nightStart;
    $("#night-end").value = state.nightEnd;
    if (!currentUser) {
      $("#night-settings-status").textContent = "Derzeit nur auf diesem Gerät gespeichert. Mit Supabase wird die Nachtzeit geräteübergreifend synchronisiert.";
    } else if (nightSettingsSyncAvailable === false) {
      $("#night-settings-status").textContent = "Datenbank-Update nötig: Die Nachtzeit ist noch nicht geräteübergreifend synchronisiert.";
    } else if (state.nightSettingsDirty) {
      $("#night-settings-status").textContent = "Änderung wird synchronisiert …";
    } else if (nightSettingsSyncAvailable === null) {
      $("#night-settings-status").textContent = "Synchronisationsstatus wird geprüft …";
    } else {
      $("#night-settings-status").textContent = "Zwischen deinen Geräten synchronisiert und rückwirkend auf alle Einträge angewendet.";
    }
    renderSleepEvents();
    renderPresets();
    updateAuthUi();
    applyTheme();
  }

  function saveNightSettingsFromForm() {
    const nightStart = normalizeTimeValue($("#night-start").value, state.nightStart);
    const nightEnd = normalizeTimeValue($("#night-end").value, state.nightEnd);
    if (nightStart === nightEnd) {
      showToast("Beginn und Ende der Nachtzeit müssen unterschiedlich sein.");
      renderSettings();
      return;
    }
    state.nightStart = nightStart;
    state.nightEnd = nightEnd;
    state.nightSettingsUpdatedAt = new Date().toISOString();
    state.nightSettingsDirty = true;
    saveState();
    renderAll();
    void syncData();
  }

  function sleepEventLabel(kind) {
    return kind === "sleep_start" ? "Schlafen gegangen" : "Aufgestanden";
  }

  function renderSleepEvents() {
    const events = [...activeSleepEvents()].reverse();
    $("#sleep-event-list").innerHTML = events.length ? events.slice(0, 30).map((event) => `
      <div class="preset-item">
        <div class="preset-copy"><strong>${sleepEventLabel(event.kind)}</strong><span>${formatDate(event.occurred_at, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} Uhr</span></div>
        <div class="preset-actions">
          <button type="button" data-edit-sleep-event="${escapeHtml(event.id)}">Bearbeiten</button>
          <button type="button" data-delete-sleep-event="${escapeHtml(event.id)}">Löschen</button>
        </div>
      </div>`).join("") : '<p class="settings-copy">Noch keine Schlaf- oder Aufstehzeit erfasst.</p>';
    if (!currentUser) {
      $("#sleep-events-status").textContent = "Derzeit nur auf diesem Gerät gespeichert.";
    } else if (sleepEventsSyncAvailable === false) {
      $("#sleep-events-status").textContent = "Datenbank-Update nötig: Schlafzeiten werden noch nicht zwischen Geräten synchronisiert.";
    } else if (sleepEventsSyncAvailable === null) {
      $("#sleep-events-status").textContent = "Synchronisationsstatus wird geprüft …";
    } else {
      $("#sleep-events-status").textContent = "Schlaf- und Aufstehzeiten werden zwischen deinen Geräten synchronisiert.";
    }
  }

  function resetSleepEventForm() {
    $("#sleep-event-form").reset();
    $("#sleep-event-edit-id").value = "";
    $("#sleep-event-kind").value = "sleep_start";
    setSplitDateTime("#sleep-event-date", "#sleep-event-time");
    $("#sleep-event-save-button").textContent = "Zeit nachtragen";
    $("#sleep-event-cancel-button").hidden = true;
  }

  function saveSleepEvent(kind, occurredAt, existingId = null) {
    const date = new Date(occurredAt);
    if (Number.isNaN(date.getTime())) throw new Error("Bitte einen gültigen Zeitpunkt wählen.");
    const existing = existingId ? state.sleepEvents.find((event) => event.id === existingId) : null;
    const now = new Date().toISOString();
    const sleepEvent = {
      id: existingId || uuid(),
      kind: kind === "wake_up" ? "wake_up" : "sleep_start",
      occurred_at: date.toISOString(),
      created_at: existing?.created_at || now,
      updated_at: now,
      deleted_at: null,
      dirty: true
    };
    if (existing) Object.assign(existing, sleepEvent); else state.sleepEvents.push(sleepEvent);
    saveState();
    renderAll();
    void syncData();
    return sleepEvent;
  }

  function recordPhaseEvent(kind) {
    saveSleepEvent(kind, new Date());
    showToast(kind === "wake_up"
      ? "Aufgestanden: Der nächste Toilettengang zählt als Morgenurin."
      : "Schlafphase gestartet.");
  }

  function beginSleepEventEdit(id) {
    const event = state.sleepEvents.find((item) => item.id === id && !item.deleted_at);
    if (!event) return;
    $("#sleep-event-edit-id").value = event.id;
    $("#sleep-event-kind").value = event.kind;
    setSplitDateTime("#sleep-event-date", "#sleep-event-time", new Date(event.occurred_at));
    $("#sleep-event-save-button").textContent = "Änderungen speichern";
    $("#sleep-event-cancel-button").hidden = false;
    $("#sleep-event-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function deleteSleepEvent(id) {
    const event = state.sleepEvents.find((item) => item.id === id && !item.deleted_at);
    if (!event || !window.confirm(`${sleepEventLabel(event.kind)} wirklich löschen?`)) return;
    event.deleted_at = new Date().toISOString();
    event.updated_at = event.deleted_at;
    event.dirty = true;
    saveState();
    resetSleepEventForm();
    renderAll();
    void syncData();
    showToast("Zeitpunkt gelöscht");
  }

  function renderAll() {
    renderQuickAmounts();
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
    const kind = ["drink", "urination", "meal"].includes(data.kind) ? data.kind : "drink";
    const amount = Number(data.amount_ml);
    if (kind !== "meal" && (!Number.isFinite(amount) || amount < 1 || amount > 5000)) throw new Error("Bitte eine Menge zwischen 1 und 5.000 ml eingeben.");
    const mealName = String(data.meal_name || "").trim();
    if (kind === "meal" && !mealName) throw new Error("Bitte die Mahlzeit kurz benennen.");
    const occurredAt = new Date(data.occurred_at || new Date());
    if (Number.isNaN(occurredAt.getTime())) throw new Error("Bitte einen gültigen Zeitpunkt wählen.");
    const existing = existingId ? state.entries.find((item) => item.id === existingId) : null;
    const entry = {
      id: existingId || uuid(),
      kind,
      amount_ml: kind === "meal" ? null : Math.round(amount),
      occurred_at: occurredAt.toISOString(),
      drink_name: kind === "drink" ? String(data.drink_name || "Getränk").trim().slice(0, 60) : null,
      meal_name: kind === "meal" ? mealName.slice(0, 80) : null,
      tags: kind === "meal" ? (data.tags || []).filter((tag) => MEAL_TAG_LABELS[tag]) : [],
      urgency: kind === "urination" && ["leicht", "mittel", "stark"].includes(data.urgency) ? data.urgency : null,
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
    $("#edit-name").value = entry.kind === "meal" ? (entry.meal_name || "") : (entry.drink_name || "");
    $("#edit-amount").value = entry.amount_ml || "";
    setSplitDateTime("#edit-date", "#edit-time", new Date(entry.occurred_at));
    $("#edit-note").value = entry.note || "";
    setRadioValue("edit-urgency", entry.urgency);
    setCheckboxValues("edit-meal-tags", entry.tags || []);
    $("#edit-dialog").showModal();
  }

  function updateEditFields() {
    const kind = $("#edit-kind").value;
    const isUrination = kind === "urination";
    const isMeal = kind === "meal";
    $("#edit-name-wrap").hidden = isUrination;
    $("#edit-name-label").textContent = isMeal ? "Mahlzeit" : "Getränk";
    $("#edit-amount-wrap").hidden = isMeal;
    $("#edit-urgency-wrap").hidden = !isUrination;
    $("#edit-meal-tags-wrap").hidden = !isMeal;
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

  function remoteEntry(entry, includeExtended = false) {
    const row = {
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
    if (includeExtended) {
      row.meal_name = entry.meal_name;
      row.tags = entry.tags || [];
    }
    return row;
  }

  function remotePreset(preset) {
    return { id: preset.id, user_id: currentUser.id, name: preset.name, amount_ml: preset.amount_ml, created_at: preset.created_at, updated_at: preset.updated_at, deleted_at: preset.deleted_at };
  }

  function remoteSleepEvent(event) {
    return {
      id: event.id,
      user_id: currentUser.id,
      kind: event.kind,
      occurred_at: event.occurred_at,
      created_at: event.created_at,
      updated_at: event.updated_at,
      deleted_at: event.deleted_at
    };
  }

  function remoteDailyContext(context) {
    return {
      user_id: currentUser.id,
      day_key: context.day_key,
      tags: context.tags || [],
      note: context.note,
      created_at: context.created_at,
      updated_at: context.updated_at,
      deleted_at: context.deleted_at
    };
  }

  function remoteNightSettings() {
    return {
      user_id: currentUser.id,
      night_start: state.nightStart,
      night_end: state.nightEnd,
      updated_at: state.nightSettingsUpdatedAt || new Date().toISOString()
    };
  }

  function mergeRemoteNightSettings(remote) {
    if (!remote) {
      state.nightSettingsUpdatedAt ||= new Date().toISOString();
      state.nightSettingsDirty = true;
      return;
    }
    const remoteUpdatedAt = new Date(remote.updated_at || 0).getTime();
    const localUpdatedAt = new Date(state.nightSettingsUpdatedAt || 0).getTime();
    if (state.nightSettingsDirty && localUpdatedAt > remoteUpdatedAt) return;
    state.nightStart = normalizeTimeValue(remote.night_start, DEFAULT_NIGHT_START);
    state.nightEnd = normalizeTimeValue(remote.night_end, DEFAULT_NIGHT_END);
    state.nightSettingsUpdatedAt = remote.updated_at;
    state.nightSettingsDirty = false;
  }

  function isMissingTable(error, table) {
    const message = String(error?.message || "").toLowerCase();
    return error?.code === "PGRST205" || error?.code === "42P01"
      || (message.includes(table) && (message.includes("does not exist") || message.includes("schema cache")));
  }

  function mergeRemote(localItems, remoteItems) {
    const map = new Map(localItems.map((item) => [item.id, item]));
    remoteItems.forEach((remote) => {
      const local = map.get(remote.id);
      if (!local || (!local.dirty && new Date(remote.updated_at) >= new Date(local.updated_at))) map.set(remote.id, { ...local, ...remote, dirty: false });
    });
    return [...map.values()];
  }

  function mergeRemoteByKey(localItems, remoteItems, key) {
    const map = new Map(localItems.map((item) => [item[key], item]));
    remoteItems.forEach((remote) => {
      const local = map.get(remote[key]);
      if (!local || (!local.dirty && new Date(remote.updated_at) >= new Date(local.updated_at))) map.set(remote[key], { ...local, ...remote, dirty: false });
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

  async function fetchOptionalRows(table) {
    try {
      return { data: await fetchAllRows(table), error: null };
    } catch (error) {
      if (isMissingTable(error, table)) return { data: [], error };
      throw error;
    }
  }

  async function syncData() {
    if (syncInProgress || !currentUser || !supabaseClient || !navigator.onLine) return;
    syncInProgress = true;
    setSyncStatus("syncing", "Synchronisiere …");
    try {
      const [remoteEntries, remotePresets, settingsResult, sleepEventsResult, dailyContextsResult] = await Promise.all([
        fetchAllRows("diary_entries"),
        fetchAllRows("drink_presets"),
        supabaseClient.from("user_settings").select("*").eq("user_id", currentUser.id).maybeSingle(),
        fetchOptionalRows("sleep_events"),
        fetchOptionalRows("daily_contexts")
      ]);
      if (settingsResult.error && !isMissingTable(settingsResult.error, "user_settings")) throw settingsResult.error;
      nightSettingsSyncAvailable = !settingsResult.error;
      sleepEventsSyncAvailable = !sleepEventsResult.error;
      extendedDiarySyncAvailable = !dailyContextsResult.error;
      state.entries = mergeRemote(state.entries, remoteEntries.map(normalizeEntry));
      state.presets = mergeRemote(state.presets, remotePresets);
      if (sleepEventsSyncAvailable) state.sleepEvents = mergeRemote(state.sleepEvents, sleepEventsResult.data);
      if (extendedDiarySyncAvailable) state.dailyContexts = mergeRemoteByKey(state.dailyContexts, dailyContextsResult.data.map((context) => ({ ...context, tags: Array.isArray(context.tags) ? context.tags : [] })), "day_key");
      if (nightSettingsSyncAvailable) mergeRemoteNightSettings(settingsResult.data);

      if (!state.defaultsMaterialized) {
        if (remotePresets.length >= DEFAULT_PRESETS.length) {
          state.defaultsMaterialized = true;
        } else {
          materializeDefaultPresets();
        }
      }

      const dirtyEntries = state.entries.filter((entry) => entry.dirty && (entry.kind !== "meal" || extendedDiarySyncAvailable));
      if (dirtyEntries.length) {
        const { error } = await supabaseClient.from("diary_entries").upsert(dirtyEntries.map((entry) => remoteEntry(entry, extendedDiarySyncAvailable)));
        if (error) throw error;
        dirtyEntries.forEach((entry) => { entry.dirty = false; });
      }
      const dirtyPresets = state.presets.filter((preset) => preset.dirty);
      if (dirtyPresets.length) {
        const { error } = await supabaseClient.from("drink_presets").upsert(dirtyPresets.map(remotePreset));
        if (error) throw error;
        dirtyPresets.forEach((preset) => { preset.dirty = false; });
      }
      const dirtySleepEvents = state.sleepEvents.filter((event) => event.dirty);
      if (sleepEventsSyncAvailable && dirtySleepEvents.length) {
        const { error } = await supabaseClient.from("sleep_events").upsert(dirtySleepEvents.map(remoteSleepEvent));
        if (error) throw error;
        dirtySleepEvents.forEach((event) => { event.dirty = false; });
      }
      const dirtyDailyContexts = state.dailyContexts.filter((context) => context.dirty);
      if (extendedDiarySyncAvailable && dirtyDailyContexts.length) {
        const { error } = await supabaseClient.from("daily_contexts").upsert(dirtyDailyContexts.map(remoteDailyContext));
        if (error) throw error;
        dirtyDailyContexts.forEach((context) => { context.dirty = false; });
      }
      if (nightSettingsSyncAvailable && state.nightSettingsDirty) {
        const { error } = await supabaseClient.from("user_settings").upsert(remoteNightSettings());
        if (error) throw error;
        state.nightSettingsDirty = false;
      }
      saveState();
      renderAll();
      if (nightSettingsSyncAvailable && sleepEventsSyncAvailable && extendedDiarySyncAvailable) {
        setSyncStatus("online", "Synchronisiert");
        $("#auth-message").textContent = "Einträge, Mahlzeiten, Tagesangaben, Getränke und Schlafzeiten sind synchronisiert.";
      } else {
        setSyncStatus("error", "Datenbank-Update nötig");
        $("#auth-message").textContent = "Die bisherigen Einträge bleiben synchronisiert. Für alle neuen Funktionen muss einmal das aktuelle Datenbank-Update ausgeführt werden.";
      }
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
        description: "Speichert ein Getränk, einen Toilettengang oder eine Mahlzeit im sichtbaren Blasentagebuch.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["drink", "urination", "meal"] },
            amount_ml: { type: "integer", minimum: 1, maximum: 5000 },
            occurred_at: { type: "string", description: "ISO-8601-Zeitpunkt; Standard ist jetzt." },
            drink_name: { type: "string", maxLength: 60 },
            meal_name: { type: "string", maxLength: 80 },
            tags: { type: "array", items: { type: "string", enum: Object.keys(MEAL_TAG_LABELS) } },
            urgency: { type: "string", enum: ["leicht", "mittel", "stark"] },
            note: { type: "string", maxLength: 130 }
          },
          required: ["kind"],
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
          const dayKey = currentDiaryDayKey();
          const stats = statsFor(entriesForDay(dayKey), dayKey);
          return { intake_ml: stats.intake, after_20_ml: stats.after20, before_sleep_3h_ml: stats.beforeSleep, urine_day_ml: stats.dayOutput, urine_night_ml: stats.nightOutput, night_share_percent: stats.nightShare, visits: stats.visits, average_ml: Math.round(stats.average), maximum_ml: stats.maximum };
        }
      });
    } catch (error) {
      console.info("WebMCP ist in diesem Browser nicht verfügbar.", error);
    }
  }

  function bindEvents() {
    $$(".type-option").forEach((button) => button.addEventListener("click", () => setKind(button.dataset.kind)));
    $(".quick-amounts").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-amount]");
      if (!button) return;
      $("#amount").value = button.dataset.amount;
      updateQuickAmountSelection();
    });
    $("#amount").addEventListener("input", updateQuickAmountSelection);
    $("#drink-preset").addEventListener("change", (event) => {
      if (event.target.value === "__add__") {
        openDrinkManagement(true);
        return;
      }
    });
    $("#manage-drinks-button").addEventListener("click", () => openDrinkManagement(false));
    ["#occurred-date", "#occurred-time"].forEach((selector) => $(selector).addEventListener("input", () => {
      occurredAtManuallySet = true;
      $("#use-current-time").hidden = false;
      updateEntryTimeSummary();
    }));
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
        const savedEntry = saveEntry({
          kind: entryKind,
          amount_ml: $("#amount").value,
          occurred_at: combinedDateTime("#occurred-date", "#occurred-time"),
          drink_name: preset?.name,
          meal_name: $("#meal-name").value,
          tags: selectedCheckboxValues("meal-tags"),
          urgency,
          note: $("#note").value
        });
        const classification = classifyEntry(savedEntry);
        showToast(classification.morningVoid
          ? `Morgenurin gespeichert und Messtag ${formatDate(dateFromKey(classification.dayKey), { day: "2-digit", month: "2-digit" })} zugeordnet.`
          : (entryKind === "drink" ? "Getränk gespeichert" : (entryKind === "meal" ? "Mahlzeit gespeichert" : "Toilettengang gespeichert")));
        $("#amount").value = "";
        $("#meal-name").value = "";
        setCheckboxValues("meal-tags", []);
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
        const editKind = $("#edit-kind").value;
        saveEntry({
          kind: editKind,
          drink_name: editKind === "drink" ? $("#edit-name").value : null,
          meal_name: editKind === "meal" ? $("#edit-name").value : null,
          tags: selectedCheckboxValues("edit-meal-tags"),
          amount_ml: $("#edit-amount").value,
          occurred_at: combinedDateTime("#edit-date", "#edit-time"),
          urgency: editUrgency,
          note: $("#edit-note").value
        }, $("#edit-id").value);
        $("#edit-dialog").close();
        showToast("Eintrag aktualisiert");
      } catch (error) { showToast(error.message); }
    });
    $("#edit-kind").addEventListener("change", updateEditFields);
    $("#daily-context-form").addEventListener("submit", (event) => {
      event.preventDefault();
      saveDailyContext($("#daily-context-day").value || currentDiaryDayKey(), selectedCheckboxValues("daily-tags"), $("#daily-note").value);
      showToast("Tagesangaben gespeichert");
    });
    $("#daily-context-day").addEventListener("change", () => renderDailyContext($("#daily-context-day").value));
    $("#delete-entry-button").addEventListener("click", () => {
      if (!window.confirm("Diesen Eintrag wirklich löschen?")) return;
      deleteEntry($("#edit-id").value);
      $("#edit-dialog").close();
      showToast("Eintrag gelöscht");
    });
    ["#doctor-from", "#doctor-to"].forEach((id) => $(id).addEventListener("change", renderDoctor));
    $("#print-button").addEventListener("click", () => window.print());
    $("#sleep-start-button").addEventListener("click", () => recordPhaseEvent("sleep_start"));
    $("#wake-up-button").addEventListener("click", () => recordPhaseEvent("wake_up"));
    $("#manage-sleep-events-button").addEventListener("click", () => {
      navigate("settings");
      $("#sleep-events-card").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("#night-start").addEventListener("change", saveNightSettingsFromForm);
    $("#night-end").addEventListener("change", saveNightSettingsFromForm);
    $("#sleep-event-form").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        saveSleepEvent(
          $("#sleep-event-kind").value,
          combinedDateTime("#sleep-event-date", "#sleep-event-time"),
          $("#sleep-event-edit-id").value || null
        );
        resetSleepEventForm();
        showToast("Schlafzeit gespeichert");
      } catch (error) { showToast(error.message); }
    });
    $("#sleep-event-list").addEventListener("click", (event) => {
      const editButton = event.target.closest("[data-edit-sleep-event]");
      if (editButton) { beginSleepEventEdit(editButton.dataset.editSleepEvent); return; }
      const deleteButton = event.target.closest("[data-delete-sleep-event]");
      if (deleteButton) deleteSleepEvent(deleteButton.dataset.deleteSleepEvent);
    });
    $("#sleep-event-cancel-button").addEventListener("click", resetSleepEventForm);
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
      if (!window.confirm("Alle lokalen Einträge, Schlafzeiten und eigenen Standardgetränke auf diesem Gerät löschen?")) return;
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
    window.addEventListener("focus", () => { refreshCurrentEntryTime(); if (currentUser) void syncData(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      refreshCurrentEntryTime();
      if (currentUser) void syncData();
    });
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
    const currentDiaryDay = dateFromKey(currentDiaryDayKey(today));
    $("#daily-context-day").value = localDayKey(currentDiaryDay);
    const from = new Date(currentDiaryDay); from.setDate(currentDiaryDay.getDate() - 6);
    $("#doctor-from").value = localDayKey(from);
    $("#doctor-to").value = localDayKey(currentDiaryDay);
    renderPresets();
    setKind("drink");
    bindEvents();
    resetSleepEventForm();
    renderAll();
    window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshCurrentEntryTime();
      renderPhaseControl();
    }, 15000);
    registerWebMcpTools();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
    try { await initSupabase(); if (currentUser) await syncData(); } catch (error) { console.error(error); setSyncStatus("error", "Sync nicht verfügbar"); }
  }

  init();
})();
