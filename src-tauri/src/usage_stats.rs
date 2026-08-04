//! 托盘徽章计算
//!
//! ## 徽章口径
//!
//! v3.7.0 起托盘只显示今日 Token 数（含缓存读取与缓存创建）。费用估算已随
//! 内置价格表一并移除，见 `docs/v3.7.0/usage-stats-rework.md`。

use serde::{Deserialize, Serialize};

/// 托盘徽章内容
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TrayBadge {
    /// 今日 Token 数
    TodayTokens { tokens: i64 },
    /// 无徽章
    None,
}

impl TrayBadge {
    /// 转为显示文本
    pub fn to_display_text(&self) -> String {
        match self {
            Self::TodayTokens { tokens } => format_token_amount(*tokens),
            Self::None => String::new(),
        }
    }
}

/// 托盘空间有限，用 K / M / B 压缩到 4 个字符以内。
fn format_token_amount(tokens: i64) -> String {
    const UNITS: [(i64, &str); 3] = [(1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")];
    for (threshold, suffix) in UNITS {
        if tokens >= threshold {
            let scaled = tokens as f64 / threshold as f64;
            return if scaled < 10.0 {
                format!("{:.1}{}", scaled, suffix)
            } else {
                format!("{:.0}{}", scaled, suffix)
            };
        }
    }
    tokens.to_string()
}

/// 徽章计算器
pub struct UsageAggregator;

impl UsageAggregator {
    /// 计算托盘徽章：今日有用量则显示 Token 数，否则不显示。
    pub fn calculate_badge(today_tokens: i64) -> TrayBadge {
        if today_tokens > 0 {
            return TrayBadge::TodayTokens {
                tokens: today_tokens,
            };
        }
        TrayBadge::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_shows_today_tokens_when_present() {
        let badge = UsageAggregator::calculate_badge(8_400_000);
        assert_eq!(badge, TrayBadge::TodayTokens { tokens: 8_400_000 });
        assert_eq!(badge.to_display_text(), "8.4M");
    }

    #[test]
    fn badge_is_empty_without_usage() {
        let badge = UsageAggregator::calculate_badge(0);
        assert_eq!(badge, TrayBadge::None);
        assert_eq!(badge.to_display_text(), "");
    }

    #[test]
    fn token_amount_formatting_covers_all_units() {
        assert_eq!(format_token_amount(950), "950");
        assert_eq!(format_token_amount(1_500), "1.5K");
        assert_eq!(format_token_amount(82_000), "82K");
        assert_eq!(format_token_amount(1_200_000), "1.2M");
        assert_eq!(format_token_amount(850_000_000), "850M");
        assert_eq!(format_token_amount(2_400_000_000), "2.4B");
    }
}
