/**
 * GAQL against Google's own field catalog (GoogleAdsFieldService): every resource, attribute, metric and segment
 * of the API version we call, with what can be selected, filtered, and combined with what. The same metadata
 * Google's Query Validator is built on.
 *
 *   gaql_fields  lets the AI look fields up before writing a query, instead of guessing names.
 *   checkGaql    finds unknown fields (with the closest real ones), fields that can't be selected or filtered,
 *                and fields that can't be used FROM the query's resource. It never blocks a query on its own:
 *                run_gaql still sends it to Google, and attaches these findings only when Google rejects it.
 *                A finding on a query Google accepts is a checker bug, and is logged as one.
 *
 * The catalog (~3,000 fields, ~2 MB) is fetched once per process and day, with any connected user's token.
 */

export interface FieldMeta {
  name: string;
  category: "RESOURCE" | "ATTRIBUTE" | "METRIC" | "SEGMENT";
  dataType?: string;
  selectable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  isRepeated?: boolean;
  /** ENUM fields: every value Google accepts. */
  enumValues?: string[];
  /**
   * RESOURCE only: resources whose attributes can be selected FROM this one, and the metrics and segments it takes.
   * `segments` also lists bare resource names ("campaign"): segmenting resources, whose attributes can be selected too.
   */
  attributeResources?: string[];
  metrics?: string[];
  segments?: string[];
}
export type Catalog = Map<string, FieldMeta>;

export const CATALOG_QUERY = "SELECT name, category, data_type, selectable, filterable, sortable, is_repeated, attribute_resources, metrics, segments, enum_values";
const TTL = 24 * 3600_000;
/** After a failed fetch, wait this long before trying again (a check is optional, so it mustn't hammer Google). */
const RETRY = 10 * 60_000;

let cached: { at: number; catalog: Catalog | null; loading?: Promise<Catalog | null> } | undefined;

/** The catalog, fetched with `fetchFields` when missing or stale. Null when it can't be had right now. */
export async function catalog(fetchFields: () => Promise<FieldMeta[]>): Promise<Catalog | null> {
  const now = Date.now();
  if (cached?.loading) return cached.loading;
  if (cached && now - cached.at < (cached.catalog ? TTL : RETRY)) return cached.catalog;
  const loading = fetchFields()
    .then((rows) => new Map(rows.map((f) => [f.name, f])) as Catalog)
    .catch((e) => { console.error(`gaql catalog: ${(e as Error).message}`); return null; })
    .then((c) => { cached = { at: Date.now(), catalog: c }; return c; });
  cached = { at: now, catalog: cached?.catalog ?? null, loading };
  return loading;
}
/** Tests only. */
export const resetCatalog = () => { cached = undefined; };

export interface ParsedGaql { select: string[]; from: string; where: string[]; orderBy: string[] }

const FIELD = /\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+\b/g;
/** SELECT … FROM … [WHERE …] [ORDER BY …] [LIMIT n] [PARAMETERS …]. Null for anything else (the check then stays out of the way). */
export function parseGaql(query: string): ParsedGaql | null {
  // Literals can hold anything, including dots and keywords: blank them before looking for field names.
  const q = query.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''").replace(/\s+/g, " ").trim();
  const m = /^SELECT (.+?) FROM ([a-z_]+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT \d+)?(?: PARAMETERS .+)?$/i.exec(q);
  if (!m) return null;
  const list = (s: string | undefined) => [...new Set((s ?? "").match(FIELD) ?? [])];
  const select = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  if (select.some((s) => !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(s))) return null;
  return { select, from: m[2]!.toLowerCase(), where: list(m[3]), orderBy: list(m[4]) };
}

/** Plain-language problems with a query, by Google's catalog. Empty when it finds none (or can't parse the query). */
export function checkGaql(query: string, cat: Catalog): string[] {
  const p = parseGaql(query);
  if (!p) return [];
  const issues: string[] = [];
  const from = cat.get(p.from);
  if (!from || from.category !== "RESOURCE") {
    const near = closest(p.from, [...cat.values()].filter((f) => f.category === "RESOURCE").map((f) => f.name));
    return [`FROM ${p.from}: there is no such resource${near.length ? `. Closest: ${near.join(", ")}` : ""}.`];
  }
  const usable = (f: FieldMeta) => fromAllows(from, f);
  const seen = new Set<string>();
  for (const [clause, names] of [["SELECT", p.select], ["WHERE", p.where], ["ORDER BY", p.orderBy]] as const) {
    for (const name of names) {
      if (seen.has(`${clause}:${name}`)) continue;
      seen.add(`${clause}:${name}`);
      const f = cat.get(name);
      if (!f) {
        // Prefer suggestions this FROM can use; fall back to any field.
        const pool = [...cat.values()].filter((x) => x.category !== "RESOURCE");
        const near = closest(name, pool.filter(usable).map((x) => x.name));
        const anywhere = near.length ? [] : closest(name, pool.map((x) => x.name));
        issues.push(`${name} doesn't exist${near.length ? `. Closest usable FROM ${p.from}: ${near.join(", ")}`
          : anywhere.length ? `. Closest: ${anywhere.join(", ")} (check what can be selected FROM ${p.from} with gaql_fields)` : ""}.`);
        continue;
      }
      if (f.category === "RESOURCE") { issues.push(`${name} is a resource, not a field: select its fields (gaql_fields resource="${name}").`); continue; }
      if (clause === "SELECT" && f.selectable === false) issues.push(`${name} can't be selected.`);
      if (clause === "WHERE" && f.filterable === false) issues.push(`${name} can't be used in WHERE.`);
      if (clause === "ORDER BY" && f.sortable === false) issues.push(`${name} can't be used in ORDER BY.`);
      if (!usable(f)) issues.push(`${name} can't be used FROM ${p.from}${whereFrom(f, cat, p.from)}.`);
    }
  }
  return [...issues, ...enumIssues(query, cat)];
}

/** An enum literal in WHERE that isn't one of the field's values (Google only says BAD_ENUM_CONSTANT): name the values it takes. */
function enumIssues(query: string, cat: Catalog): string[] {
  const where = /\bWHERE\b([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|\bPARAMETERS\b|$)/i.exec(query)?.[1] ?? "";
  const issues: string[] = [];
  const COND = /\b([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\s*(?:!=|=|NOT\s+IN|IN)\s*(\([^)]*\)|'[^']*'|"[^"]*"|[A-Z][A-Z0-9_]*)/gi;
  for (const [, name, rhs] of where.matchAll(COND)) {
    const values = cat.get(name!)?.enumValues;
    if (!values?.length) continue;
    const given = (rhs!.match(/'[^']*'|"[^"]*"|[A-Za-z][A-Za-z0-9_]*/g) ?? []).map((v) => v.replace(/^['"]|['"]$/g, ""));
    const bad = given.filter((v) => !values.includes(v));
    if (!bad.length) continue;
    const valid = values.filter((v) => v !== "UNKNOWN" && v !== "UNSPECIFIED");
    issues.push(`${bad.map((v) => `'${v}'`).join(", ")} ${bad.length > 1 ? "aren't values" : "isn't a value"} of ${name}. It takes: `
      + `${valid.slice(0, 40).join(", ")}${valid.length > 40 ? ", …" : ""}.`);
  }
  return issues;
}

/** Whether a query FROM `from` can use field `f`: its own attributes, its attribute resources', and its metrics and segments. */
function fromAllows(from: FieldMeta, f: FieldMeta): boolean {
  if (f.category === "METRIC") return (from.metrics ?? []).includes(f.name);
  if (f.category === "SEGMENT") return (from.segments ?? []).includes(f.name);
  const res = f.name.split(".")[0]!;
  return res === from.name || (from.attributeResources ?? []).includes(res) || (from.segments ?? []).includes(res);
}

/** Account-wide resources first: they answer "per X" questions without splitting by ad group too. */
const BROAD = ["customer", "campaign"];

/**
 * ": query it FROM x" — the resources that can use this field, the field's own resource first. When the query's FROM
 * is also a segment (segments.conversion_action), the resources that take both come first, since splitting by it is
 * what that query wanted: `metrics.conversions FROM conversion_action` was pointed at ad_group (catalog order), not
 * at customer or campaign with segments.conversion_action (2026-10-15).
 */
function whereFrom(f: FieldMeta, cat: Catalog, from?: string): string {
  const own = f.category === "ATTRIBUTE" ? f.name.split(".")[0]! : null;
  const ok = [...cat.values()].filter((r) => r.category === "RESOURCE" && fromAllows(r, f)).map((r) => r.name);
  const seg = from && cat.get(`segments.${from}`)?.category === "SEGMENT" ? `segments.${from}` : null;
  const split = seg ? ok.filter((r) => (cat.get(r)!.segments ?? []).includes(seg)) : [];
  if (split.length) {
    const broad = BROAD.filter((r) => split.includes(r));
    const pick = broad.length ? broad : split.slice(0, 4);
    return `; to split it by ${from}, query it FROM ${pick.join(" or FROM ")} with ${seg} in SELECT`;
  }
  const pick = [...(own && ok.includes(own) ? [own] : []), ...ok.filter((r) => r !== own)].slice(0, 4);
  return pick.length ? `; query it FROM ${pick.join(" or FROM ")}` : "";
}

/**
 * The real names closest to `name`: every one sharing its last part (up to 8), else up to three near misses. A shared last part (e.g. "cpc_bid_ceiling_micros") counts most, since
 * that's what a model usually gets right while guessing the path to it; then edit distance on the whole name.
 */
export function closest(name: string, pool: string[]): string[] {
  const parts = name.split(".");
  const leaf = parts.at(-1)!;
  const scored = pool.map((c) => {
    const cp = c.split(".");
    let s = levenshtein(name, c);
    if (cp.at(-1) === leaf) s -= 100;
    else if (cp.at(-1)!.includes(leaf) || leaf.includes(cp.at(-1)!)) s -= 20;
    if (cp[0] === parts[0]) s -= 10;
    return { c, s };
  }).sort((a, b) => a.s - b.s);
  const best = scored[0];
  if (!best) return [];
  // Same last part (e.g. every *.cpc_bid_ceiling_micros): offer them all, since the path is what was guessed wrong and
  // names alone can't tell which (maximize clicks is target_spend in the API, say).
  const sameLeaf = scored.filter((x) => x.c.split(".").at(-1) === leaf);
  if (sameLeaf.length) return sameLeaf.slice(0, 8).map((x) => x.c);
  // Otherwise only names that are plausibly what was meant.
  const limit = Math.max(4, Math.floor(name.length / 3));
  return scored.filter((x) => x.s <= best.s + 3 && (x.s < 0 || x.s <= limit)).slice(0, 3).map((x) => x.c);
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * gaql_fields: a resource's own fields, the resources it can also select from, and its metrics and segments; or,
 * with only `search`, matching names across the whole catalog. `search` filters by substring (any of its words).
 */
export function lookupFields(cat: Catalog, o: { resource?: string; search?: string }) {
  const words = (o.search ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  const hit = (n: string) => !words.length || words.some((w) => n.includes(w));
  const CAP = 200;
  const capped = (xs: string[]) => ({ names: xs.slice(0, CAP), ...(xs.length > CAP ? { more: xs.length - CAP } : {}) });
  if (!o.resource) {
    if (!words.length) throw new Error("Give a resource (e.g. campaign) or search words (e.g. bid ceiling).");
    const all = [...cat.values()].filter((f) => f.category !== "RESOURCE" && f.selectable !== false && hit(f.name));
    return { matches: capped(all.map((f) => `${f.name} (${f.category.toLowerCase()}${f.dataType ? `, ${f.dataType}` : ""})`)),
      tip: "Pass resource to see what one FROM can use; attributes belong to the resource named before their first dot." };
  }
  const r = cat.get(o.resource.toLowerCase());
  if (!r || r.category !== "RESOURCE") {
    const near = closest(o.resource, [...cat.values()].filter((f) => f.category === "RESOURCE").map((f) => f.name));
    throw new Error(`No resource "${o.resource}"${near.length ? `. Closest: ${near.join(", ")}` : ""}.`);
  }
  const own = [...cat.values()].filter((f) => f.category === "ATTRIBUTE" && f.name.startsWith(`${r.name}.`) && hit(f.name));
  return {
    resource: r.name,
    fields: capped(own.map((f) => `${f.name} ${f.dataType ?? ""}${f.isRepeated ? "[]" : ""}${f.filterable === false ? " (not filterable)" : ""}`.trim())),
    also_select_from: [...(r.attributeResources ?? []), ...(r.segments ?? []).filter((s) => !s.includes("."))],
    metrics: capped((r.metrics ?? []).filter(hit)),
    segments: capped((r.segments ?? []).filter((s) => s.includes(".") && hit(s))),
  };
}
