import { FILTERS, RANGES, optionLabel, type FilterName, type RangeValue } from "./data/filters";

// A dashboard's filter bar, written out as the statements of its program. create_dashboard
// hands these to the builder as they are, so the date presets and every option are the values
// the data tools read, and the examples the builder learns from use the same ones.

const option = (value: string, label: string) =>
  `{value: ${JSON.stringify(value)}, label: ${JSON.stringify(label)}}`;

/**
 * `$range`, one `$variable` per filter, and the FilterBar that sets them: a date filter that
 * opens on `start`, then a dropdown per filter that opens on all.
 */
export function filterStatements(
  start: RangeValue,
  names: readonly FilterName[],
  { compare = false } = {},
): string {
  const date = `DateRangeFilter($range, [${RANGES.map((range) => option(range.value, range.label)).join(", ")}], "Date range")`;
  const selects = names.map((name) => {
    const { label, all, values } = FILTERS[name];
    const options = [option("", all), ...values.map((value) => option(value, optionLabel(value)))];
    return `SelectFilter($${name}, [${options.join(", ")}], ${JSON.stringify(label)})`;
  });
  const bar = [date, ...selects, ...(compare ? ['CompareToggle("Previous period", true)'] : [])];
  return [
    `$range = ${JSON.stringify(start)}`,
    ...names.map((name) => `$${name} = ""`),
    `filters = FilterBar([${bar.join(", ")}])`,
  ].join("\n");
}

/** The arguments that make a Query follow the filters: `range: $range, region: $region`. */
export const filterArgs = (names: readonly FilterName[]) =>
  ["range: $range", ...names.map((name) => `${name}: $${name}`)].join(", ");

/**
 * What create_dashboard adds to its prompt: the filters, wired the same way on every dashboard,
 * and the parts every dashboard has, so a request that names only a table still opens on
 * headline numbers and shows the split and the trend.
 */
export function dashboardBrief(start: RangeValue, names: readonly FilterName[]): string {
  const split = names[0] ? `the ${FILTERS[names[0]].label.toLowerCase()}s` : "its main breakdown";
  return [
    `Layout, top to bottom. Where the description above leaves a part out, add it from the data tools: a lead Kpis strip of 3 to 5 headline numbers, with previous values where a tool gives them; a chart comparing ${split}; a chart over time; a detail table. Every number is live from the sales database, so nothing is labelled sample data.`,
    'Filters. Start the program with these statements as they are, with `filters` first in Dashboard([...]). Add CompareToggle("Previous period", true) after the last filter only when a card is given previous values.',
    filterStatements(start, names),
    `Every Query, the headline numbers' included, passes ${filterArgs(names)}, leaving out only an argument its tool doesn't take. No Query sets its own period, and no title, subtitle or hint names one: the date filter does.`,
  ].join("\n");
}
