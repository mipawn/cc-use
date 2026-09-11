/**
 * The account query a provider starts from before one is written for it.
 *
 * A template rather than a vendor default — there is no default to know — but
 * not blank either: it names the variables, the two halves of a script and the
 * fields an extractor returns, so the shape is visible without reading about
 * it first. Presets replace it with their own service's script.
 */
export const STARTER_ACCOUNT_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/api/user/balance",
    method: "GET",
    headers: {
      Authorization: "Bearer {{apiKey}}"
    }
  },
  extractor: function (response) {
    return {
      remaining: response.data.balance,
      unit: "USD"
    }
  }
})`

/** Field names and endpoint are examples; map them to the provider's API. */
export const ROLLING_WINDOW_ACCOUNT_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/api/usage",
    method: "GET",
    headers: { Authorization: "Bearer {{apiKey}}" }
  },
  extractor: function (response) {
    // Example response: data.five_hour = { used: 30, limit: 100, resets_at: "..." }
    const window = response.data.five_hour;
    return {
      windows: [{
        id: "rolling_5h",
        label: "5h",
        usedPercent: window.limit > 0 ? window.used / window.limit * 100 : null,
        resetsAt: window.resets_at || null
      }]
    };
  }
})`
