//! One-time upgrade of the shipped Command Code account template.
//!
//! The template that shipped with v3.17.0 read `windowLimits` from inside the
//! `credits` object. The live `GET /alpha/billing/credits` answer carries it
//! beside `credits` on the response body — the place the public client reads
//! it — so untouched copies of that template never produced the 5h/weekly
//! windows, and the monthly row (gated on those limits) never appeared either.
//!
//! A provider or key still holding that template verbatim is moved to the
//! corrected text once. A script that differs by a single character is a saved
//! choice and stays untouched: the query script is editable text, and this
//! upgrade only rescues what the release shipped.

use super::Database;

/// The v3.17.0 template, frozen here so the comparison does not drift when the
/// shipped template changes again. Nothing executes this text.
const SUPERSEDED_COMMAND_CODE_SCRIPT: &str = r#"({
  requests: {
    credit: {                                     // 必需
      url: "https://api.commandcode.ai/alpha/billing/credits",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" }
    },
    subscription: {                               // 可选：查不到 → 月窗留 loading，不整刷失败
      url: "https://api.commandcode.ai/alpha/billing/subscriptions",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" },
      optional: true
    },
    summary: {                                    // 可选：月度"已用"来源
      url: "https://api.commandcode.ai/alpha/usage/summary",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" },
      optional: true
    }
  },
  extractor: function (responses) {
    // 套餐月总额（credits 单位），按 subscriptions 返回的 planId 精确查表；
    // 这是客户端 1.88.4 的快照，套餐新增/改名需要手动改这里。
    var planTotal = { "individual-go":10, "individual-go-v1":10, "individual-goat":70,
      "individual-pro":30, "individual-pro-v1":80, "individual-provider":15,
      "individual-max":150, "individual-ultra":300, "teams-pro":40 }

    var num = function (value) {
      if (value == null) return null
      var n = Number(value)
      return isFinite(n) ? n : null
    }
    var msToIso = function (value) {
      var ms = num(value)
      if (ms == null) return null
      var date = new Date(ms)
      return isNaN(date.getTime()) ? null : date.toISOString()
    }
    var anyIso = function (value) {           // resetAt 可能是毫秒数字或可解析时间串
      var ms = num(value)
      if (ms != null) {
        var date = new Date(ms)
        return isNaN(date.getTime()) ? null : date.toISOString()
      }
      if (value == null) return null
      var parsed = new Date(String(value))
      return isNaN(parsed.getTime()) ? null : parsed.toISOString()
    }
    // credits 块：客户端存在两种嵌套读法（research.md 复核节）
    var top = function (body) {
      if (body == null || typeof body !== "object") return null
      var outer = body.credits
      if (outer == null || typeof outer !== "object") return null
      var amounts = outer.credits != null && typeof outer.credits === "object" ? outer.credits : outer
      var limits = outer.windowLimits != null && typeof outer.windowLimits === "object"
        ? outer.windowLimits
        : (amounts.windowLimits != null && typeof amounts.windowLimits === "object"
          ? amounts.windowLimits
          : null)
      return { amounts: amounts, limits: limits,
        planId: (outer.planId != null ? outer.planId : (amounts.planId != null ? amounts.planId : null)) }
    }
    var credits = top(responses.credit)
    if (credits == null) return { isValid: false, invalidMessage: "响应里没有可读的 credits 对象" }
    var monthly = num(credits.amounts.monthlyCredits)
    var purchased = num(credits.amounts.purchasedCredits)
    var free = num(credits.amounts.freeCredits)
    // 三个数值全缺＝接口正常但没报余额，不得汇总成 0（真实 0 剩余会是具体数字）
    if (monthly == null && purchased == null && free == null) {
      return { isValid: false, invalidMessage: "credits 数值缺失" }
    }
    var usage = {
      remaining: (monthly != null && monthly > 0 ? monthly : 0)
        + (purchased != null && purchased > 0 ? purchased : 0)
        + (free != null && free > 0 ? free : 0),
      unit: "credits"   // usage-value units；不做 $ 换算、不标 USD
    }
    var windows = []
    var push = function (id, limit) {
      if (limit == null || typeof limit !== "object") return
      var cap = num(limit.cap)
      var used = num(limit.used)
      windows.push({
        id: id,                                   // rolling/weekly/monthly：UI 字典给文案与排序
        usedPercent: cap != null && cap > 0 && used != null
          ? Math.min(100, used / cap * 100)
          : null,                                 // cap 缺失/≤0 → 未返回
        resetsAt: msToIso(limit.resetAt)          // 毫秒 → ISO 落到 UI 既有倒计时
      })
    }
    // windowLimits 存在＝套餐账号：5h/周窗照常，月窗行始终产出（查不到的输入 →
    // percent 留空为"未返回"，不虚构）；windowLimits 不在＝按量账号，连月窗也不虚构造行。
    if (credits.limits != null) {
      push("rolling", credits.limits.fiveHour)
      push("weekly", credits.limits.weekly)

      // 月窗："已用"来自 summary.totalCost，"总额度"来自 subscription.planId → planTotal；
      // 任一缺失 → 百分比留空（loading/未返回），不虚构。subscription 未查到时
      // 状态无法确认，百分比同样留空；resetAt 只在订阅体里有时才有。
      var subResp = responses.subscription
      var sumResp = responses.summary
      var sub = subResp != null && subResp.data != null && typeof subResp.data === "object" ? subResp.data : null
      var sum = sumResp != null && typeof sumResp === "object" ? sumResp : null
      var rawPlanId = sub != null && sub.planId != null ? sub.planId : credits.planId
      var planKey = rawPlanId != null ? String(rawPlanId).toLowerCase().replace(/_/g, "-") : null
      var total = planKey != null ? planTotal[planKey] : null    // 精确匹配；未知 → null
      // summary 体形未在客户端留痕（CLI 只读顶层 totalCost），data 包裹时再降一层，
      // 两处都没有就用不上"已用"，百分比留空，不虚构。
      var sumData = sum != null && sum.data != null && typeof sum.data === "object" ? sum.data : sum
      var used = sumData != null ? num(sumData.totalCost) : null
      var periodEnd = sub != null && sub.currentPeriodEnd != null ? anyIso(sub.currentPeriodEnd) : null
      var statusOk = sub != null
        && (sub.status == null || sub.status === "active" || sub.status === "trialing")
      var percent = total != null && total > 0 && used != null && used >= 0 && statusOk
        ? Math.min(100, Math.max(0, used / total * 100))
        : null
      windows.push({ id: "monthly", usedPercent: percent, resetsAt: periodEnd })
    }
    usage.windows = windows
    return usage
  }
})"#;

impl Database {
    pub(super) fn upgrade_command_code_scripts(&self) -> Result<(), rusqlite::Error> {
        let marker = "migration.command-code.window-limits-fixed";
        if self.settings_get_value(marker)?.is_some() {
            return Ok(());
        }

        let corrected = crate::shared_runtime::account_scripts::command_code_script();
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute(
            "UPDATE providers SET wallet_balance_script = ?1 WHERE wallet_balance_script = ?2",
            rusqlite::params![corrected, SUPERSEDED_COMMAND_CODE_SCRIPT],
        )?;
        // A key may have pasted the same template into its own quota query.
        transaction.execute(
            "UPDATE api_keys SET usage_script = ?1 WHERE usage_script = ?2",
            rusqlite::params![corrected, SUPERSEDED_COMMAND_CODE_SCRIPT],
        )?;
        transaction.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, 'true')",
            [marker],
        )?;
        transaction.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "migration.command-code.window-limits-fixed";

    fn upgraded() -> Database {
        let db = Database::new_in_memory().unwrap();
        db.conn
            .execute("DELETE FROM settings WHERE key = ?1", [MARKER])
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO providers (id, name, base_url, preset_id, wallet_balance_script)
                 VALUES ('cc', 'command code', 'https://api.commandcode.ai/provider',
                         'command-code', ?1)",
                [SUPERSEDED_COMMAND_CODE_SCRIPT],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO api_keys (id, provider_id, value, usage_script)
                 VALUES ('key', 'cc', 'test', ?1)",
                [SUPERSEDED_COMMAND_CODE_SCRIPT],
            )
            .unwrap();
        // One character of edit makes it a saved choice: untouched.
        let edited = format!("{SUPERSEDED_COMMAND_CODE_SCRIPT}\n// mine");
        db.conn
            .execute(
                "INSERT INTO providers (id, name, base_url, wallet_balance_script)
                 VALUES ('edited', 'edited', 'https://api.commandcode.ai/provider', ?1)",
                [edited.as_str()],
            )
            .unwrap();
        db.upgrade_command_code_scripts().unwrap();
        db
    }

    fn text(db: &Database, sql: &str) -> String {
        db.conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn untouched_shipped_templates_move_to_the_corrected_script() {
        let db = upgraded();
        let corrected = crate::shared_runtime::account_scripts::command_code_script();

        let provider_script = text(
            &db,
            "SELECT wallet_balance_script FROM providers WHERE id='cc'",
        );
        assert_eq!(provider_script, corrected);
        assert!(provider_script.contains("body.windowLimits"));

        let key_script = text(&db, "SELECT usage_script FROM api_keys WHERE id='key'");
        assert_eq!(key_script, corrected);
    }

    #[test]
    fn an_edited_script_is_a_saved_choice_and_stays() {
        let db = upgraded();

        let script = text(
            &db,
            "SELECT wallet_balance_script FROM providers WHERE id='edited'",
        );
        assert_eq!(script, format!("{SUPERSEDED_COMMAND_CODE_SCRIPT}\n// mine"));
    }

    /// The marker is the whole reason a script re-saved as the superseded text
    /// later is not rewritten: an upgrade happens once, not on every boot.
    #[test]
    fn the_upgrade_runs_once() {
        let db = upgraded();
        db.conn
            .execute(
                "UPDATE providers SET wallet_balance_script = ?1 WHERE id='edited'",
                [SUPERSEDED_COMMAND_CODE_SCRIPT],
            )
            .unwrap();

        db.upgrade_command_code_scripts().unwrap();

        assert_eq!(
            text(
                &db,
                "SELECT wallet_balance_script FROM providers WHERE id='edited'"
            ),
            SUPERSEDED_COMMAND_CODE_SCRIPT
        );
    }

    /// The frozen text has to be the template the fix actually replaces:
    /// same three requests and optionality, only the limits lookup differs.
    #[test]
    fn the_frozen_script_is_the_one_the_fix_replaces() {
        let corrected = crate::shared_runtime::account_scripts::command_code_script();

        assert_ne!(SUPERSEDED_COMMAND_CODE_SCRIPT, corrected);
        assert!(!SUPERSEDED_COMMAND_CODE_SCRIPT.contains("body.windowLimits"));
        assert!(corrected.contains("body.windowLimits"));
        for endpoint in [
            "alpha/billing/credits",
            "alpha/billing/subscriptions",
            "alpha/usage/summary",
        ] {
            assert!(SUPERSEDED_COMMAND_CODE_SCRIPT.contains(endpoint));
            assert!(corrected.contains(endpoint));
        }
        assert_eq!(
            SUPERSEDED_COMMAND_CODE_SCRIPT
                .matches("optional: true")
                .count(),
            2
        );
        assert_eq!(
            SUPERSEDED_COMMAND_CODE_SCRIPT.matches("{{apiKey}}").count(),
            corrected.matches("{{apiKey}}").count()
        );
    }
}
