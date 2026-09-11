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
