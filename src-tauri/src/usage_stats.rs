//! 费用统计聚合与托盘徽章计算
//!
//! 实现费用统计的聚合逻辑和托盘徽章内容计算。
//!
//! ## 徽章口径
//!
//! v3.2.1 起托盘只显示今日费用。代理状态、活跃实例数和请求数仍可
//! 在菜单或页面中展示,但不再参与 badge 内容选择。

use serde::{Deserialize, Serialize};

/// 托盘徽章内容
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TrayBadge {
    /// 代理异常
    ProxyError,
    /// 活跃实例数量
    ActiveInstances { count: u32 },
    /// 今日费用
    TodayCost { amount: f64, currency: String },
    /// 今日请求数
    TodayRequests { count: u32 },
    /// 无徽章
    None,
}

impl TrayBadge {
    /// 转为显示文本
    pub fn to_display_text(&self) -> String {
        match self {
            Self::ProxyError => "!".to_string(),
            Self::ActiveInstances { count } => count.to_string(),
            Self::TodayCost { amount, currency } => {
                if currency == "USD" {
                    format_usd_amount(*amount)
                } else {
                    format!("{}{:.2}", currency, amount)
                }
            }
            Self::TodayRequests { count } => count.to_string(),
            Self::None => String::new(),
        }
    }
}

/// 格式化 USD 金额为简短形式
fn format_usd_amount(amount: f64) -> String {
    if amount >= 999.95 {
        format!("${:.1}k", amount / 1000.0)
    } else if amount >= 1.0 {
        format!("${:.1}", amount)
    } else if amount >= 0.01 {
        format!("${:.2}", amount)
    } else if amount > 0.0 {
        format!("$<0.01")
    } else {
        "$0".to_string()
    }
}

/// 统计维度
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageAggregation {
    pub total_requests: u32,
    pub total_cost: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub by_client: Vec<ClientStats>,
    pub by_provider: Vec<ProviderStats>,
    pub by_model: Vec<ModelStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientStats {
    pub client_type: String,
    pub requests: u32,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStats {
    pub provider_id: String,
    pub provider_name: String,
    pub requests: u32,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStats {
    pub model_name: String,
    pub requests: u32,
    pub cost: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// 费用统计器
pub struct UsageAggregator;

impl UsageAggregator {
    /// 计算托盘徽章
    pub fn calculate_badge(
        _proxy_running: bool,
        _active_instances: u32,
        today_cost: f64,
        _today_requests: u32,
    ) -> TrayBadge {
        if today_cost > 0.0 {
            return TrayBadge::TodayCost {
                amount: today_cost,
                currency: "USD".to_string(),
            };
        }

        TrayBadge::None
    }

    /// 估算费用（按模型价格表）
    pub fn estimate_cost(
        model: &str,
        input_tokens: u64,
        output_tokens: u64,
        cost_multiplier: f64,
    ) -> f64 {
        let (input_price, output_price) = Self::get_model_pricing(model);

        let base_cost = (input_tokens as f64 * input_price / 1_000_000.0)
            + (output_tokens as f64 * output_price / 1_000_000.0);

        base_cost * cost_multiplier
    }

    /// 获取模型定价（USD per 1M tokens）
    fn get_model_pricing(model: &str) -> (f64, f64) {
        // 返回 (input_price_per_1M, output_price_per_1M)
        match model {
            // Claude models
            "claude-opus-4" => (15.0, 75.0),
            "claude-sonnet-4" => (3.0, 15.0),
            "claude-haiku-4" => (0.8, 4.0),
            "claude-3-5-sonnet-20241022" => (3.0, 15.0),
            "claude-3-5-haiku-20241022" => (0.8, 4.0),

            // OpenAI models
            "gpt-4o" => (2.5, 10.0),
            "gpt-4o-mini" => (0.15, 0.6),
            "gpt-4-turbo" => (10.0, 30.0),
            "gpt-3.5-turbo" => (0.5, 1.5),

            // DeepSeek models
            "deepseek-chat" => (0.14, 0.28),
            "deepseek-reasoner" => (0.55, 2.19),

            // Default fallback
            _ => (1.0, 2.0),
        }
    }

    /// 聚合统计（占位实现，真实实现需查询数据库）
    pub fn aggregate_usage(_start_date: &str, _end_date: &str) -> Result<UsageAggregation, String> {
        // 占位：真实实现需要查询 request_logs 和 usage_logs 表
        Ok(UsageAggregation {
            total_requests: 0,
            total_cost: 0.0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            by_client: Vec::new(),
            by_provider: Vec::new(),
            by_model: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_badge_ignores_proxy_error_when_today_cost_exists() {
        let badge = UsageAggregator::calculate_badge(false, 2, 10.0, 100);
        assert_eq!(
            badge,
            TrayBadge::TodayCost {
                amount: 10.0,
                currency: "USD".to_string()
            }
        );
        assert_eq!(badge.to_display_text(), "$10.0");
    }

    #[test]
    fn test_badge_ignores_active_instances_when_today_cost_exists() {
        let badge = UsageAggregator::calculate_badge(true, 2, 10.0, 100);
        assert_eq!(
            badge,
            TrayBadge::TodayCost {
                amount: 10.0,
                currency: "USD".to_string()
            }
        );
        assert_eq!(badge.to_display_text(), "$10.0");
    }

    #[test]
    fn test_badge_priority_today_cost() {
        let badge = UsageAggregator::calculate_badge(true, 0, 5.67, 100);
        assert_eq!(
            badge,
            TrayBadge::TodayCost {
                amount: 5.67,
                currency: "USD".to_string()
            }
        );
        assert_eq!(badge.to_display_text(), "$5.7");
    }

    #[test]
    fn test_badge_does_not_fallback_to_today_requests() {
        let badge = UsageAggregator::calculate_badge(true, 0, 0.0, 42);
        assert_eq!(badge, TrayBadge::None);
        assert_eq!(badge.to_display_text(), "");
    }

    #[test]
    fn test_badge_priority_none() {
        let badge = UsageAggregator::calculate_badge(true, 0, 0.0, 0);
        assert_eq!(badge, TrayBadge::None);
        assert_eq!(badge.to_display_text(), "");
    }

    #[test]
    fn test_format_usd_amount() {
        assert_eq!(format_usd_amount(1234.56), "$1.2k");
        assert_eq!(format_usd_amount(999.99), "$1.0k");
        assert_eq!(format_usd_amount(5.67), "$5.7");
        assert_eq!(format_usd_amount(0.82), "$0.82");
        assert_eq!(format_usd_amount(0.005), "$<0.01");
        assert_eq!(format_usd_amount(0.0), "$0");
    }

    #[test]
    fn test_estimate_cost_claude_opus() {
        let cost = UsageAggregator::estimate_cost("claude-opus-4", 1_000_000, 500_000, 1.0);
        // (1M * $15 / 1M) + (0.5M * $75 / 1M) = $15 + $37.5 = $52.5
        assert_eq!(cost, 52.5);
    }

    #[test]
    fn test_estimate_cost_with_multiplier() {
        let cost = UsageAggregator::estimate_cost("claude-sonnet-4", 1_000_000, 1_000_000, 1.5);
        // (1M * $3 / 1M) + (1M * $15 / 1M) = $3 + $15 = $18
        // $18 * 1.5 = $27
        assert_eq!(cost, 27.0);
    }

    #[test]
    fn test_estimate_cost_gpt4o_mini() {
        let cost = UsageAggregator::estimate_cost("gpt-4o-mini", 2_000_000, 1_000_000, 1.0);
        // (2M * $0.15 / 1M) + (1M * $0.6 / 1M) = $0.3 + $0.6 = $0.9
        assert!((cost - 0.9).abs() < 0.001);
    }

    #[test]
    fn test_estimate_cost_deepseek() {
        let cost = UsageAggregator::estimate_cost("deepseek-chat", 5_000_000, 2_000_000, 1.0);
        // (5M * $0.14 / 1M) + (2M * $0.28 / 1M) = $0.7 + $0.56 = $1.26
        assert!((cost - 1.26).abs() < 0.001);
    }

    #[test]
    fn test_estimate_cost_unknown_model_fallback() {
        let cost = UsageAggregator::estimate_cost("unknown-model", 1_000_000, 1_000_000, 1.0);
        // Fallback: (1M * $1 / 1M) + (1M * $2 / 1M) = $1 + $2 = $3
        assert_eq!(cost, 3.0);
    }

    #[test]
    fn test_model_pricing_coverage() {
        // 验证常见模型定价存在
        let models = vec![
            "claude-opus-4",
            "claude-sonnet-4",
            "claude-haiku-4",
            "gpt-4o",
            "gpt-4o-mini",
            "deepseek-chat",
            "deepseek-reasoner",
        ];

        for model in models {
            let (input, output) = UsageAggregator::get_model_pricing(model);
            assert!(input > 0.0, "Model {} should have input pricing", model);
            assert!(output > 0.0, "Model {} should have output pricing", model);
        }
    }
}
