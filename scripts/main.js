import {
  appendTrackedRoll,
  calculateTrackedStatistics,
  extractD10FaceFromContent,
  extractD10FacesFromRolls,
  selectTrackedRolls,
} from "./statistics.js";
import { themeClassForSystem } from "./theme.js";

const MODULE_ID = "d10-roll-tracker";
const FLAG_KEY = "statistics";
const TEMPLATE_PATH = `modules/${MODULE_ID}/templates/roll-tracker.hbs`;
const STATS_CHAT_TEMPLATE = `modules/${MODULE_ID}/templates/stats-chat.hbs`;
const COMPARISON_CHAT_TEMPLATE = `modules/${MODULE_ID}/templates/comparison-chat.hbs`;
const EMPTY_VALUE = "—";

const SETTINGS = {
  MAX_ROLLS: "maxRolls",
  COUNT_BLIND: "countBlindRolls",
  STREAK_VISIBILITY: "streakVisibility",
  STREAK_THRESHOLD: "streakThreshold",
};

let trackerApplication;
let recordingQueue = Promise.resolve();

function currentThemeClass() {
  return themeClassForSystem(game.system?.id);
}

function localize(key) {
  return game.i18n.localize(`CPRRollTracker.${key}`);
}

function formatStatistic(value) {
  if (value === null) return EMPTY_VALUE;
  return new Intl.NumberFormat(game.i18n.lang, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 2,
  }).format(value);
}

function statisticsForUser(user, combatOnly = false) {
  const stored = user.getFlag(MODULE_ID, FLAG_KEY);
  return calculateTrackedStatistics(stored, combatOnly);
}

function visibleUsers() {
  if (!game.user.isGM) return [game.user];

  return [...game.users].sort((left, right) => {
    if (left.id === game.user.id) return -1;
    if (right.id === game.user.id) return 1;
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.name.localeCompare(right.name, game.i18n.lang);
  });
}

class RollTrackerApplication extends Application {
  constructor(options = {}) {
    super(options);
    this.combatOnly = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "cpr-roll-tracker",
      classes: ["cpr-roll-tracker", currentThemeClass()],
      template: TEMPLATE_PATH,
      title: localize("Title"),
      width: 900,
      height: "auto",
      resizable: true,
    });
  }

  async getData(options = {}) {
    const data = await super.getData(options);

    data.isGM = game.user.isGM;
    data.themeClass = currentThemeClass();
    data.combatOnly = this.combatOnly;
    data.viewLabel = localize(this.combatOnly ? "CombatView" : "AllView");
    data.toggleLabel = localize(
      this.combatOnly ? "ShowAllRolls" : "ShowCombatRolls"
    );
    data.scopeText = localize(game.user.isGM ? "GMScope" : "PlayerScope");
    data.users = visibleUsers().map((user) => {
      const stats = statisticsForUser(user, this.combatOnly);
      return {
        id: user.id,
        name: user.name,
        active: user.active,
        isSelf: user.id === game.user.id,
        role: localize(user.isGM ? "GameMaster" : "Player"),
        total: stats.total,
        ones: `${stats.ones} (${stats.onesPercentage}%)`,
        tens: `${stats.tens} (${stats.tensPercentage}%)`,
        median: formatStatistic(stats.median),
        average: formatStatistic(stats.average),
        mode: stats.mode.length > 0 ? stats.mode.join(", ") : EMPTY_VALUE,
        modeCount: stats.modeCount,
        lastRoll: formatStatistic(stats.lastRoll),
      };
    });

    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.on("click", "[data-action]", (event) => this._handleAction(event));
  }

  async _handleAction(event) {
    event.preventDefault();
    const action = event.currentTarget.dataset.action;
    const userId = event.currentTarget.dataset.userId;

    switch (action) {
      case "toggle-combat":
        this.combatOnly = !this.combatOnly;
        return this.render(false);
      case "print":
        return printStatistics(userId, this.combatOnly);
      case "export":
        return exportStatistics(userId, this.combatOnly);
      case "clear":
        return clearStatistics(userId, this);
      case "compare":
        return printComparison(this.combatOnly);
      default:
        return undefined;
    }
  }
}

function openTracker() {
  trackerApplication ??= new RollTrackerApplication();
  trackerApplication.render(true);
  return trackerApplication;
}

function chatMessageUserId(message) {
  if (typeof message.user === "string") return message.user;
  return message.user?.id ?? message.author?.id ?? null;
}

function extractMessageD10s(message) {
  const standardResults = extractD10FacesFromRolls(message.rolls);
  if (standardResults.length > 0) return standardResults;

  const cprResult = extractD10FaceFromContent(message.content);
  return cprResult === null ? [] : [cprResult];
}

function isCombatActive() {
  return Boolean(game.combat?.started ?? game.combat?.round > 0);
}

async function recordD10s(faces, { blind = false } = {}) {
  let current = game.user.getFlag(MODULE_ID, FLAG_KEY);
  const streaks = [];
  const options = {
    blind,
    combat: isCombatActive(),
    maxRolls: game.settings.get(MODULE_ID, SETTINGS.MAX_ROLLS),
    streakThreshold: game.settings.get(MODULE_ID, SETTINGS.STREAK_THRESHOLD),
  };

  for (const face of faces) {
    const result = appendTrackedRoll(current, face, options);
    current = result.data;
    if (result.streak) streaks.push(result.streak);
  }

  await game.user.setFlag(MODULE_ID, FLAG_KEY, current);
  for (const streak of streaks) announceStreak(game.user, streak);
}

function enqueueMessage(message) {
  if (chatMessageUserId(message) !== game.user.id) return;

  if (
    message.blind &&
    !game.user.isGM &&
    !game.settings.get(MODULE_ID, SETTINGS.COUNT_BLIND)
  ) {
    return;
  }

  const faces = extractMessageD10s(message);
  if (faces.length === 0) return;

  recordingQueue = recordingQueue
    .then(() => recordD10s(faces, { blind: message.blind }))
    .catch((error) => {
      console.error(`${MODULE_ID} | Failed to record d10 result`, error);
    });
}

function canAccessUser(userId) {
  return Boolean(userId) && (game.user.isGM || userId === game.user.id);
}

function getAccessibleUser(userId) {
  if (!canAccessUser(userId)) throw new Error(localize("PermissionError"));
  return game.users.get(userId) ?? null;
}

function userStatisticsContext(user, combatOnly) {
  const stats = statisticsForUser(user, combatOnly);
  return {
    themeClass: currentThemeClass(),
    user: { id: user.id, name: user.name },
    combatOnly,
    viewLabel: localize(combatOnly ? "CombatView" : "AllView"),
    stats: {
      ...stats,
      average: formatStatistic(stats.average),
      median: formatStatistic(stats.median),
      mode: stats.mode.length > 0 ? stats.mode.join(", ") : EMPTY_VALUE,
      lastRoll: formatStatistic(stats.lastRoll),
    },
  };
}

async function printStatistics(userId, combatOnly) {
  const user = getAccessibleUser(userId);
  if (!user) return;

  const content = await renderTemplate(
    STATS_CHAT_TEMPLATE,
    userStatisticsContext(user, combatOnly)
  );
  await ChatMessage.create({
    user: game.user.id,
    content,
    speaker: { alias: localize("Title") },
  });
}

function safeFileName(value) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").trim() || "user";
}

function exportStatistics(userId, combatOnly) {
  const user = getAccessibleUser(userId);
  if (!user) return;

  const stored = user.getFlag(MODULE_ID, FLAG_KEY);
  const rolls = selectTrackedRolls(stored, combatOnly);
  if (rolls.length === 0) {
    ui.notifications.warn(localize("NoData"));
    return;
  }

  const csv = [
    "roll,combat",
    ...rolls.map((roll) => `${roll.value},${roll.combat}`),
  ].join("\n");
  const suffix = combatOnly ? "-combat" : "";
  saveDataToFile(
    csv,
    "text/csv",
    `${safeFileName(user.name)}-d10-rolls${suffix}.csv`
  );
}

async function clearStatistics(userId, application) {
  const user = getAccessibleUser(userId);
  if (!user) return;

  const confirmed = await Dialog.confirm({
    title: localize("ClearTitle"),
    content: `<p>${localize("ClearConfirm").replace(
      "{name}",
      foundry.utils.escapeHTML(user.name)
    )}</p>`,
  });
  if (!confirmed) return;

  await user.unsetFlag(MODULE_ID, FLAG_KEY);
  application.render(false);
}

function rankedNames(rows, property, direction = "max") {
  const populated = rows.filter((row) => row.stats.total > 0);
  if (populated.length === 0) return { names: EMPTY_VALUE, value: EMPTY_VALUE };

  const values = populated.map((row) => row.stats[property]);
  const target = direction === "min" ? Math.min(...values) : Math.max(...values);
  return {
    names: populated
      .filter((row) => row.stats[property] === target)
      .map((row) => row.user.name)
      .join(", "),
    value: formatStatistic(target),
  };
}

async function printComparison(combatOnly) {
  if (!game.user.isGM) throw new Error(localize("PermissionError"));

  const rows = visibleUsers().map((user) => ({
    user,
    stats: statisticsForUser(user, combatOnly),
  }));
  if (!rows.some((row) => row.stats.total > 0)) {
    ui.notifications.warn(localize("NoData"));
    return;
  }

  const context = {
    themeClass: currentThemeClass(),
    combatOnly,
    viewLabel: localize(combatOnly ? "CombatView" : "AllView"),
    users: rows.map(({ user, stats }) => ({
      name: user.name,
      total: stats.total,
      ones: stats.ones,
      tens: stats.tens,
      median: formatStatistic(stats.median),
      average: formatStatistic(stats.average),
    })),
    highestAverage: rankedNames(rows, "average"),
    lowestAverage: rankedNames(rows, "average", "min"),
    mostOnes: rankedNames(rows, "ones"),
    mostTens: rankedNames(rows, "tens"),
  };
  const content = await renderTemplate(COMPARISON_CHAT_TEMPLATE, context);
  await ChatMessage.create({
    user: game.user.id,
    content,
    speaker: { alias: localize("Title") },
  });
}

function activePrimaryGM() {
  return [...game.users]
    .filter((user) => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
}

function createStreakMessage(payload) {
  const visibility = game.settings.get(
    MODULE_ID,
    SETTINGS.STREAK_VISIBILITY
  );
  if (visibility === "disabled") return;

  const values = Array.isArray(payload.values)
    ? payload.values
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 10)
    : [];
  if (values.length === 0) return;

  const userName =
    game.users.get(payload.userId)?.name ?? String(payload.userName ?? "");

  const whisper =
    payload.includesBlind || visibility === "gm"
      ? [...game.users].filter((user) => user.isGM).map((user) => user.id)
      : undefined;
  ChatMessage.create({
    user: game.user.id,
    content: `<div class="cpr-roll-tracker-streak ${currentThemeClass()}"><strong>${localize(
      "StreakTitle"
    ).replace("{name}", foundry.utils.escapeHTML(userName))}</strong><span>${values.join(
      ", "
    )}</span></div>`,
    speaker: { alias: localize("Title") },
    whisper,
  });
}

function announceStreak(user, streak) {
  const payload = {
    type: "streak",
    userId: user.id,
    userName: user.name,
    values: streak.values,
    includesBlind: streak.includesBlind,
  };
  const primaryGM = activePrimaryGM();

  if (game.user.isGM || !primaryGM) {
    createStreakMessage(payload);
  } else {
    game.socket.emit(`module.${MODULE_ID}`, payload);
  }
}

function registerSettings() {
  game.settings.register(MODULE_ID, SETTINGS.MAX_ROLLS, {
    name: "CPRRollTracker.Settings.MaxRollsName",
    hint: "CPRRollTracker.Settings.MaxRollsHint",
    scope: "world",
    config: true,
    type: Number,
    default: 50,
    range: { min: 10, max: 500, step: 10 },
  });
  game.settings.register(MODULE_ID, SETTINGS.COUNT_BLIND, {
    name: "CPRRollTracker.Settings.CountBlindName",
    hint: "CPRRollTracker.Settings.CountBlindHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, SETTINGS.STREAK_VISIBILITY, {
    name: "CPRRollTracker.Settings.StreakVisibilityName",
    hint: "CPRRollTracker.Settings.StreakVisibilityHint",
    scope: "world",
    config: true,
    type: String,
    default: "public",
    choices: {
      disabled: localize("Settings.StreakDisabled"),
      gm: localize("Settings.StreakGM"),
      public: localize("Settings.StreakPublic"),
    },
  });
  game.settings.register(MODULE_ID, SETTINGS.STREAK_THRESHOLD, {
    name: "CPRRollTracker.Settings.StreakThresholdName",
    hint: "CPRRollTracker.Settings.StreakThresholdHint",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
    range: { min: 2, max: 5, step: 1 },
  });
}

function addTokenControl(controls) {
  const tokenControls = Array.isArray(controls)
    ? controls.find((control) => control.name === "token")
    : controls.tokens ?? controls.token;
  if (!tokenControls) return;

  const tool = {
    name: "cpr-roll-tracker",
    title: localize("ControlTooltip"),
    icon: "fas fa-dice-d10",
    button: true,
    visible: true,
    onClick: openTracker,
  };

  if (Array.isArray(tokenControls.tools)) {
    tokenControls.tools.push(tool);
  } else if (tokenControls.tools) {
    tokenControls.tools[tool.name] = tool;
  }
}

function statisticsFlagChanged(changes) {
  const namespacePath = `flags.${MODULE_ID}`;
  return (
    foundry.utils.hasProperty(changes, namespacePath) ||
    Object.keys(changes).some((key) => key.startsWith(namespacePath))
  );
}

Hooks.once("init", registerSettings);

Hooks.once("ready", () => {
  const module = game.modules.get(MODULE_ID);
  module.api = {
    open: openTracker,
    getStatistics(userId = game.user.id, { combatOnly = false } = {}) {
      if (!game.user.isGM && userId !== game.user.id) {
        throw new Error(localize("PermissionError"));
      }

      const user = game.users.get(userId);
      return user ? statisticsForUser(user, combatOnly) : null;
    },
  };

  game.socket.on(`module.${MODULE_ID}`, (payload) => {
    if (
      payload?.type === "streak" &&
      activePrimaryGM()?.id === game.user.id
    ) {
      createStreakMessage(payload);
    }
  });
});

Hooks.on("getSceneControlButtons", addTokenControl);
Hooks.on("createChatMessage", enqueueMessage);
Hooks.on("updateUser", (_user, changes) => {
  if (statisticsFlagChanged(changes) && trackerApplication?.rendered) {
    trackerApplication.render(false);
  }
});
