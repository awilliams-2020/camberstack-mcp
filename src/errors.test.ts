import { describe, expect, it } from "vitest";
import { AdsApiError } from "./google.js";
import { expandDuring } from "./session.js";

/** Google's error body for one GAQL error, as the REST API returns it. */
const body = (code: Record<string, string>, message: string, field?: string) => JSON.stringify({
  error: { details: [{ errors: [{ errorCode: code, message,
    ...(field ? { location: { fieldPathElements: [{ fieldName: field }] } } : {}) }] }] },
});

describe("AdsApiError fix hints", () => {
  // Each case is an error users actually hit (tool_calls.error), with its message as Google sent it.
  it.each([
    [{ queryError: "INVALID_VALUE_WITH_DURING_OPERATOR" }, "Invalid date literal supplied for DURING operator: LAST_90_DAYS.", undefined, "BETWEEN"],
    [{ queryError: "PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE" }, "Cannot select or filter on the following metrics: 'search_budget_lost_impression_share'", undefined, "FROM campaign"],
    [{ queryError: "UNRECOGNIZED_FIELD" }, "Unrecognized field in the query: 'campaign.start_date'.", undefined, "campaign.start_date_time"],
    [{ queryError: "BAD_FIELD_NAME" }, "Error in WHERE clause: invalid field name '('.", undefined, "no parentheses or OR"],
    [{ queryError: "EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE" }, "The following field must be present in SELECT clause: 'campaign.id'.", undefined, "add that field to SELECT"],
    [{ queryError: "EXPECTED_FILTERS_ON_DATE_RANGE" }, "Expects filters on the following field to limit a finite date range: 'segments.date'.", undefined, "finite range"],
    [{ fieldError: "INVALID_VALUE" }, "The input has an invalid value.", "geo_target_constants", "FROM geo_target_constant"],
  ])("%j → hint", (code, message, field, hint) => {
    const e = new AdsApiError(400, body(code, message, field));
    expect(e.message).toContain(message);   // Google's own words stay
    expect(e.message).toContain(`→ `);
    expect(e.message).toContain(hint);
  });

  it("adds nothing for errors it has no fix for", () => {
    const e = new AdsApiError(403, body({ authorizationError: "USER_PERMISSION_DENIED" }, "User doesn't have permission."));
    expect(e.message).toBe("Google Ads API 403: USER_PERMISSION_DENIED User doesn't have permission.");
  });
});

describe("expandDuring", () => {
  it("runs an unsupported LAST_N_DAYS as explicit dates", () => {
    const { query, rewrote } = expandDuring("SELECT campaign.id FROM campaign WHERE segments.date DURING LAST_90_DAYS AND campaign.status = 'ENABLED'");
    expect(query).toMatch(/WHERE segments\.date BETWEEN '\d{4}-\d\d-\d\d' AND '\d{4}-\d\d-\d\d' AND campaign\.status = 'ENABLED'$/);
    const [, start, end] = /BETWEEN '([\d-]+)' AND '([\d-]+)'/.exec(query)!;
    expect((Date.parse(end) - Date.parse(start)) / 86_400_000).toBe(89);   // 90 days, inclusive
    expect(rewrote).toHaveLength(1);
  });

  it("leaves the windows Google supports alone", () => {
    const q = "SELECT metrics.clicks FROM campaign WHERE segments.date DURING last_30_days";
    expect(expandDuring(q)).toEqual({ query: q, rewrote: [] });
  });
});
