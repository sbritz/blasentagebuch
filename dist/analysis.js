(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BladderAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const URGENCY_LEVELS = ["leicht", "mittel", "stark"];
  const DEFAULT_LARGE_DRINK_ML = 300;
  const MAX_RECORDED_PHASE_HOURS = 20;

  function finiteValues(values) {
    return values.map(Number).filter(Number.isFinite);
  }

  function mean(values) {
    const numbers = finiteValues(values);
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
  }

  function median(values) {
    const numbers = finiteValues(values).sort((a, b) => a - b);
    if (!numbers.length) return null;
    const middle = Math.floor(numbers.length / 2);
    return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
  }

  function percentageDifference(baseline, comparison) {
    const base = Number(baseline);
    const next = Number(comparison);
    if (!Number.isFinite(base) || !Number.isFinite(next) || base === 0) return null;
    return (next - base) / Math.abs(base) * 100;
  }

  function pearson(pairs) {
    const valid = pairs
      .map((pair) => [Number(pair[0]), Number(pair[1])])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (valid.length < 3) return null;
    const xMean = mean(valid.map(([x]) => x));
    const yMean = mean(valid.map(([, y]) => y));
    const numerator = valid.reduce((sum, [x, y]) => sum + (x - xMean) * (y - yMean), 0);
    const xSpread = valid.reduce((sum, [x]) => sum + (x - xMean) ** 2, 0);
    const ySpread = valid.reduce((sum, [, y]) => sum + (y - yMean) ** 2, 0);
    const denominator = Math.sqrt(xSpread * ySpread);
    return denominator ? numerator / denominator : null;
  }

  function timestamp(value) {
    const result = new Date(value).getTime();
    return Number.isFinite(result) ? result : null;
  }

  function nextClockBoundaryTimestamp(value, clockTime) {
    const reference = new Date(value);
    const match = String(clockTime || "").match(/^(\d{2}):(\d{2})$/);
    if (Number.isNaN(reference.getTime()) || !match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    const boundary = new Date(reference);
    boundary.setHours(hour, minute, 0, 0);
    if (boundary.getTime() <= reference.getTime()) boundary.setDate(boundary.getDate() + 1);
    return boundary.getTime();
  }

  function phaseEventExpiryTimestamp(event, nextEvent, nightStart, nightEnd) {
    const eventTime = timestamp(event?.occurred_at);
    if (eventTime === null) return null;
    const defaultBoundary = nextClockBoundaryTimestamp(eventTime, event.kind === "sleep_start" ? nightEnd : nightStart);
    const nextTime = timestamp(nextEvent?.occurred_at);
    const isOppositeTransition = (event.kind === "sleep_start" && nextEvent?.kind === "wake_up")
      || (event.kind === "wake_up" && nextEvent?.kind === "sleep_start");
    const maximumRecordedPhase = MAX_RECORDED_PHASE_HOURS * 60 * 60 * 1000;
    if (isOppositeTransition && nextTime > eventTime && nextTime - eventTime <= maximumRecordedPhase) return nextTime;
    return defaultBoundary;
  }

  function minutesBefore(eventTime, referenceTime) {
    const event = timestamp(eventTime);
    const reference = timestamp(referenceTime);
    if (event === null || reference === null || event > reference) return null;
    return (reference - event) / 60000;
  }

  function sumAmounts(entries) {
    return entries.reduce((sum, entry) => sum + Number(entry.amount_ml || 0), 0);
  }

  function lastBefore(entries, referenceTime, predicate = () => true) {
    const reference = timestamp(referenceTime);
    if (reference === null) return null;
    return entries
      .filter((entry) => predicate(entry) && timestamp(entry.occurred_at) !== null && timestamp(entry.occurred_at) <= reference)
      .sort((a, b) => timestamp(b.occurred_at) - timestamp(a.occurred_at))[0] || null;
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function computeDayMetrics({ dayKey, entries = [], sleepAt, context = {}, largeDrinkMl = DEFAULT_LARGE_DRINK_ML }) {
    const active = entries.filter((entry) => !entry.deleted_at);
    const drinks = active.filter((entry) => entry.kind === "drink");
    const urinations = active.filter((entry) => entry.kind === "urination");
    const meals = active.filter((entry) => entry.kind === "meal");
    const dayUrinations = urinations.filter((entry) => entry.phase !== "night");
    const nightUrinations = urinations.filter((entry) => entry.phase === "night");
    const sleepTime = timestamp(sleepAt);
    const lateDrinks = sleepTime === null ? [] : drinks.filter((entry) => {
      const occurred = timestamp(entry.occurred_at);
      return occurred !== null && occurred <= sleepTime && occurred >= sleepTime - 3 * 60 * 60 * 1000;
    });
    const lastMeal = lastBefore(meals, sleepAt);
    const lastLargeDrink = lastBefore(drinks, sleepAt, (entry) => Number(entry.amount_ml || 0) >= largeDrinkMl);
    const totalUrineMl = sumAmounts(urinations);
    const urgency = Object.fromEntries(URGENCY_LEVELS.map((level) => {
      const matching = urinations.filter((entry) => entry.urgency === level);
      return [level, { count: matching.length, averageMl: mean(matching.map((entry) => entry.amount_ml)) }];
    }));

    return {
      dayKey,
      intakeMl: sumAmounts(drinks),
      totalUrineMl,
      nightUrineMl: sumAmounts(nightUrinations),
      nightSharePercent: totalUrineMl ? sumAmounts(nightUrinations) / totalUrineMl * 100 : null,
      dayVisits: dayUrinations.length,
      nightVisits: nightUrinations.filter((entry) => !entry.morningVoid).length,
      averageVoidMl: mean(urinations.map((entry) => entry.amount_ml)),
      maximumVoidMl: urinations.length ? Math.max(...urinations.map((entry) => Number(entry.amount_ml || 0))) : null,
      urgency,
      beforeSleep3hMl: sumAmounts(lateDrinks),
      minutesLastMealToSleep: lastMeal ? minutesBefore(lastMeal.occurred_at, sleepAt) : null,
      minutesLastLargeDrinkToSleep: lastLargeDrink ? minutesBefore(lastLargeDrink.occurred_at, sleepAt) : null,
      mealTags: unique(meals.flatMap((entry) => Array.isArray(entry.tags) ? entry.tags : [])),
      dailyFactors: unique(Array.isArray(context.tags) ? context.tags : [])
    };
  }

  function summarizeContinuous(days, xKey, yKey) {
    const pairs = days
      .map((day) => [day[xKey], day[yKey]])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    return {
      count: pairs.length,
      xMean: mean(pairs.map(([x]) => x)),
      xMedian: median(pairs.map(([x]) => x)),
      yMean: mean(pairs.map(([, y]) => y)),
      yMedian: median(pairs.map(([, y]) => y)),
      correlation: pearson(pairs)
    };
  }

  function compareTaggedDays(days, collectionKey, tag, outcomeKey) {
    const withDays = days.filter((day) => (day[collectionKey] || []).includes(tag) && Number.isFinite(day[outcomeKey]));
    const withoutDays = days.filter((day) => !(day[collectionKey] || []).includes(tag) && Number.isFinite(day[outcomeKey]));
    const withTag = withDays.map((day) => day[outcomeKey]);
    const withoutTag = withoutDays.map((day) => day[outcomeKey]);
    const withMean = mean(withTag);
    const withoutMean = mean(withoutTag);
    return {
      tag,
      outcomeKey,
      withCount: withTag.length,
      withoutCount: withoutTag.length,
      withDayKeys: withDays.map((day) => day.dayKey).filter(Boolean),
      withoutDayKeys: withoutDays.map((day) => day.dayKey).filter(Boolean),
      withMean,
      withMedian: median(withTag),
      withoutMean,
      withoutMedian: median(withoutTag),
      absoluteDifference: withMean === null || withoutMean === null ? null : withMean - withoutMean,
      percentageDifference: percentageDifference(withoutMean, withMean)
    };
  }

  function compareByMedian(days, xKey, yKey) {
    const valid = days.filter((day) => Number.isFinite(day[xKey]) && Number.isFinite(day[yKey]));
    const splitValue = median(valid.map((day) => day[xKey]));
    if (splitValue === null) return null;
    const lower = valid.filter((day) => day[xKey] <= splitValue);
    const higher = valid.filter((day) => day[xKey] > splitValue);
    if (!lower.length || !higher.length) return null;
    return {
      splitValue,
      lowerCount: lower.length,
      higherCount: higher.length,
      lowerDayKeys: lower.map((day) => day.dayKey).filter(Boolean),
      higherDayKeys: higher.map((day) => day.dayKey).filter(Boolean),
      lowerXMean: mean(lower.map((day) => day[xKey])),
      higherXMean: mean(higher.map((day) => day[xKey])),
      lowerYMean: mean(lower.map((day) => day[yKey])),
      higherYMean: mean(higher.map((day) => day[yKey])),
      absoluteDifference: mean(higher.map((day) => day[yKey])) - mean(lower.map((day) => day[yKey])),
      percentageDifference: percentageDifference(mean(lower.map((day) => day[yKey])), mean(higher.map((day) => day[yKey])))
    };
  }

  function observedPatterns(days, options = {}) {
    if (days.length < 3) return [];
    const mealTags = options.mealTags || unique(days.flatMap((day) => day.mealTags || []));
    const dailyFactors = options.dailyFactors || unique(days.flatMap((day) => day.dailyFactors || []));
    const candidates = [];
    let order = 0;
    const addContinuous = (id, xKey, yKey) => {
      const summary = summarizeContinuous(days, xKey, yKey);
      const comparison = compareByMedian(days, xKey, yKey);
      if (!comparison || !Number.isFinite(summary.correlation) || Math.abs(summary.correlation) < .2 || comparison.absoluteDifference === 0) return;
      candidates.push({ id, kind: "continuous", xKey, yKey, summary, comparison, score: Math.abs(summary.correlation), order: order++ });
    };
    addContinuous("late-intake-night-urine", "beforeSleep3hMl", "nightUrineMl");
    addContinuous("late-intake-night-visits", "beforeSleep3hMl", "nightVisits");
    addContinuous("intake-total-urine", "intakeMl", "totalUrineMl");

    const addTagged = (kind, collectionKey, tags) => tags.forEach((tag) => {
      const comparison = compareTaggedDays(days, collectionKey, tag, "nightUrineMl");
      if (comparison.withCount < 3 || comparison.withoutCount < 2 || !Number.isFinite(comparison.absoluteDifference) || comparison.absoluteDifference === 0) return;
      const scale = Math.max(1, Math.abs(comparison.withoutMean));
      candidates.push({ id: `${kind}-${tag}`, kind, tag, comparison, score: Math.abs(comparison.absoluteDifference) / scale, order: order++ });
    });
    addTagged("mealTag", "mealTags", mealTags);
    addTagged("dailyFactor", "dailyFactors", dailyFactors);

    return candidates
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, Math.max(0, options.maxPatterns || 5))
      .map(({ score, order: candidateOrder, ...candidate }) => candidate);
  }

  function analyzePatterns(days, options = {}) {
    const mealTags = options.mealTags || unique(days.flatMap((day) => day.mealTags || []));
    const dailyFactors = options.dailyFactors || unique(days.flatMap((day) => day.dailyFactors || []));
    const outcomes = ["nightUrineMl", "nightVisits", "nightSharePercent"];
    const comparisons = (collectionKey, tags) => tags.map((tag) => ({
      tag,
      outcomes: Object.fromEntries(outcomes.map((outcome) => [outcome, compareTaggedDays(days, collectionKey, tag, outcome)]))
    }));
    return {
      dayCount: days.length,
      continuous: {
        lateIntakeNightUrine: summarizeContinuous(days, "beforeSleep3hMl", "nightUrineMl"),
        lateIntakeNightVisits: summarizeContinuous(days, "beforeSleep3hMl", "nightVisits"),
        intakeUrine: summarizeContinuous(days, "intakeMl", "totalUrineMl")
      },
      mealTags: comparisons("mealTags", mealTags),
      dailyFactors: comparisons("dailyFactors", dailyFactors)
    };
  }

  return {
    DEFAULT_LARGE_DRINK_ML,
    MAX_RECORDED_PHASE_HOURS,
    URGENCY_LEVELS,
    mean,
    median,
    percentageDifference,
    pearson,
    nextClockBoundaryTimestamp,
    phaseEventExpiryTimestamp,
    minutesBefore,
    computeDayMetrics,
    summarizeContinuous,
    compareTaggedDays,
    compareByMedian,
    observedPatterns,
    analyzePatterns
  };
});
