const D10_SIDES = 10;

/**
 * Turn unknown persisted data into a safe ten-slot d10 histogram.
 *
 * @param {unknown} value Persisted counts.
 * @returns {number[]} A new array containing counts for faces 1 through 10.
 */
export function normalizeCounts(value) {
  const source = Array.isArray(value) ? value : [];

  return Array.from({ length: D10_SIDES }, (_, index) => {
    const count = Number(source[index]);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  });
}

/**
 * Add one d10 face to a histogram without mutating the input.
 *
 * @param {unknown} value Persisted counts.
 * @param {unknown} face Rolled face.
 * @returns {number[]} The updated histogram.
 */
export function addD10Result(value, face) {
  const counts = normalizeCounts(value);
  const numericFace = Number(face);

  if (!Number.isInteger(numericFace) || numericFace < 1 || numericFace > 10) {
    return counts;
  }

  counts[numericFace - 1] += 1;
  return counts;
}

function valueAtPosition(counts, position) {
  let seen = 0;

  for (let index = 0; index < counts.length; index += 1) {
    seen += counts[index];
    if (seen >= position) return index + 1;
  }

  return null;
}

/**
 * Calculate exact statistics from a d10 histogram.
 *
 * @param {unknown} value Persisted counts.
 * @returns {{counts: number[], total: number, ones: number, tens: number, median: number|null, average: number|null}}
 */
export function calculateStatistics(value) {
  const counts = normalizeCounts(value);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const sum = counts.reduce(
    (result, count, index) => result + count * (index + 1),
    0
  );

  let median = null;
  if (total > 0) {
    if (total % 2 === 1) {
      median = valueAtPosition(counts, (total + 1) / 2);
    } else {
      const lower = valueAtPosition(counts, total / 2);
      const upper = valueAtPosition(counts, total / 2 + 1);
      median = (lower + upper) / 2;
    }
  }

  return {
    counts,
    total,
    ones: counts[0],
    tens: counts[9],
    median,
    average: total > 0 ? sum / total : null,
  };
}

function normalizeRoll(entry) {
  const value = Number(typeof entry === "object" ? entry?.value : entry);
  if (!Number.isInteger(value) || value < 1 || value > 10) return null;

  return {
    value,
    combat: Boolean(typeof entry === "object" && entry?.combat),
  };
}

/**
 * Normalize the persisted, bounded roll history. Schema 1 histograms from the
 * first module build are migrated without losing aggregate statistics.
 *
 * @param {unknown} value Persisted tracker data.
 * @returns {{schema: number, rolls: {value: number, combat: boolean}[], streak: {values: number[], includesBlind: boolean}}}
 */
export function normalizeTrackedData(value) {
  let rolls = [];

  if (value && typeof value === "object" && Array.isArray(value.rolls)) {
    rolls = value.rolls.map(normalizeRoll).filter(Boolean);
  } else if (value && typeof value === "object" && Array.isArray(value.counts)) {
    const counts = normalizeCounts(value.counts);
    counts.forEach((count, index) => {
      for (let occurrence = 0; occurrence < count; occurrence += 1) {
        rolls.push({ value: index + 1, combat: false });
      }
    });
  }

  const streakValues = Array.isArray(value?.streak?.values)
    ? value.streak.values
        .map(Number)
        .filter((face) => Number.isInteger(face) && face >= 1 && face <= 10)
    : [];

  return {
    schema: 2,
    rolls,
    streak: {
      values: streakValues,
      includesBlind: Boolean(value?.streak?.includesBlind),
    },
  };
}

/**
 * Append one result to bounded history and update the upstream-style streak:
 * consecutive rolls are part of a streak when they differ by at most one.
 *
 * @param {unknown} value Persisted tracker data.
 * @param {unknown} face Rolled face.
 * @param {{combat?: boolean, blind?: boolean, maxRolls?: number, streakThreshold?: number}} options Recording options.
 * @returns {{data: ReturnType<typeof normalizeTrackedData>, streak: {values: number[], includesBlind: boolean}|null}}
 */
export function appendTrackedRoll(value, face, options = {}) {
  const data = normalizeTrackedData(value);
  const numericFace = Number(face);
  if (!Number.isInteger(numericFace) || numericFace < 1 || numericFace > 10) {
    return { data, streak: null };
  }

  const previousFace = data.rolls.at(-1)?.value;
  const blind = Boolean(options.blind);
  let streakValues = data.streak.values;
  let includesBlind = data.streak.includesBlind || blind;

  if (
    previousFace !== undefined &&
    Math.abs(previousFace - numericFace) <= 1
  ) {
    if (streakValues.length === 0) streakValues = [previousFace];
    streakValues = [...streakValues, numericFace];
  } else {
    streakValues = [];
    includesBlind = blind;
  }

  data.rolls.push({
    value: numericFace,
    combat: Boolean(options.combat),
  });

  const requestedLimit = Number(options.maxRolls);
  const maxRolls = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : 50;
  if (data.rolls.length > maxRolls) {
    data.rolls.splice(0, data.rolls.length - maxRolls);
  }

  // A streak cannot usefully exceed the retained roll history.
  if (streakValues.length > maxRolls) {
    streakValues = streakValues.slice(-maxRolls);
  }

  data.streak = { values: streakValues, includesBlind };

  const requestedThreshold = Number(options.streakThreshold);
  const threshold = Number.isInteger(requestedThreshold) && requestedThreshold >= 2
    ? requestedThreshold
    : 3;

  return {
    data,
    streak:
      streakValues.length >= threshold
        ? { values: [...streakValues], includesBlind }
        : null,
  };
}

/**
 * Select either all retained rolls or only rolls made during active combat.
 *
 * @param {unknown} value Persisted tracker data.
 * @param {boolean} combatOnly Whether to select the combat subset.
 * @returns {{value: number, combat: boolean}[]}
 */
export function selectTrackedRolls(value, combatOnly = false) {
  const rolls = normalizeTrackedData(value).rolls;
  return combatOnly ? rolls.filter((roll) => roll.combat) : rolls;
}

/**
 * Calculate the requested d10 values plus the upstream Roll Tracker's mode,
 * percentages, last roll, and bounded sample size.
 *
 * @param {unknown} value Persisted tracker data.
 * @param {boolean} combatOnly Whether to use only combat rolls.
 * @returns {ReturnType<typeof calculateStatistics> & {mode: number[], modeCount: number, onesPercentage: number, tensPercentage: number, lastRoll: number|null}}
 */
export function calculateTrackedStatistics(value, combatOnly = false) {
  const rolls = selectTrackedRolls(value, combatOnly);
  const counts = rolls.reduce(
    (histogram, roll) => addD10Result(histogram, roll.value),
    normalizeCounts([])
  );
  const statistics = calculateStatistics(counts);
  const modeCount = Math.max(0, ...counts);
  const mode = modeCount > 0
    ? counts.flatMap((count, index) => (count === modeCount ? [index + 1] : []))
    : [];

  return {
    ...statistics,
    mode,
    modeCount,
    onesPercentage:
      statistics.total > 0
        ? Math.round((statistics.ones / statistics.total) * 100)
        : 0,
    tensPercentage:
      statistics.total > 0
        ? Math.round((statistics.tens / statistics.total) * 100)
        : 0,
    lastRoll: rolls.at(-1)?.value ?? null,
  };
}

/**
 * Extract a d10 face from one of Cyberpunk RED CORE's die image paths.
 *
 * @param {unknown} source Image URL.
 * @returns {number|null} The face, if the URL describes a d10 face.
 */
export function extractD10FaceFromImage(source) {
  if (typeof source !== "string") return null;

  const match = source.match(
    /(?:^|\/)d10_(10|[1-9])(?:_(?:preem|fail))?\.svg(?:[?#].*)?$/i
  );
  return match ? Number(match[1]) : null;
}

function allActiveResults(results) {
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry) => {
    const value = Number(entry?.result);
    return entry &&
      entry.active !== false &&
      entry.discarded !== true &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 10
      ? [value]
      : [];
  });
}

function findD10ResultsInTerm(term) {
  if (!term || typeof term !== "object") return [];

  if (Number(term.faces) === D10_SIDES) {
    const results = allActiveResults(term.results);
    if (results.length > 0) return results;
  }

  for (const nested of [term.terms, term.rolls]) {
    if (!Array.isArray(nested)) continue;
    for (const child of nested) {
      const results = findD10ResultsInTerm(child);
      if (results.length > 0) return results;
    }
  }

  for (const nested of [term.term, term.roll]) {
    const results = findD10ResultsInTerm(nested);
    if (results.length > 0) return results;
  }

  return [];
}

/**
 * Return the first active d10 result from standard Foundry Roll objects.
 *
 * @param {unknown} rolls ChatMessage rolls.
 * @returns {number|null} The initial d10 face.
 */
export function extractD10FaceFromRolls(rolls) {
  return extractD10FacesFromRolls(rolls)[0] ?? null;
}

/**
 * Return all active results from the first d10 term in standard Foundry rolls.
 * This preserves Roll Tracker's handling of multi-die/fortune-style rolls.
 *
 * @param {unknown} rolls ChatMessage rolls.
 * @returns {number[]} Rolled d10 faces.
 */
export function extractD10FacesFromRolls(rolls) {
  if (!Array.isArray(rolls)) return [];

  for (const roll of rolls) {
    const results = findD10ResultsInTerm(roll);
    if (results.length > 0) return results;
  }

  return [];
}

/**
 * Read the first die image from a Cyberpunk RED CORE d10 roll card. The first
 * image is the initial d10; a critical follow-up die, when present, is second.
 *
 * @param {unknown} content ChatMessage HTML.
 * @returns {number|null} The initial d10 face.
 */
export function extractD10FaceFromContent(content) {
  if (typeof content !== "string" || !content.includes("d10-rollcard-data")) {
    return null;
  }

  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(content, "text/html");
    const diceContainer =
      document.querySelector(".d10-rollcard-data .d10-dice-div") ??
      document.querySelector(".d10-rollcard-data");

    for (const image of diceContainer?.querySelectorAll("img") ?? []) {
      const face = extractD10FaceFromImage(image.getAttribute("src"));
      if (face !== null) return face;
    }
    return null;
  }

  // A small non-browser fallback keeps the parser testable without emulating a
  // full DOM. Limit the search to the beginning of the detected d10 card.
  const marker = content.indexOf("d10-rollcard-data");
  const cardFragment = content.slice(marker, marker + 4000);
  const imageSources = cardFragment.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi);
  for (const [, source] of imageSources) {
    const face = extractD10FaceFromImage(source);
    if (face !== null) return face;
  }

  return null;
}
