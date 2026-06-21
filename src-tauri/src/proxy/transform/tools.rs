//! Function calling (工具调用) 格式对齐
//!
//! 不同 API 的 function calling 格式有差异,需要转换。

/// 命名空间工具名拍平 + 截断到 64 字符(OpenAI function name 上限)。
///
/// 规则:
/// - `.` `/` ` ` `:` → `_`
/// - 超过 64 字符则截断
///
/// # Examples
///
/// ```
/// use cc_use_lib::proxy::transform::tools::flatten_tool_name;
///
/// assert_eq!(flatten_tool_name("mcp.github.list_repos"), "mcp_github_list_repos");
/// assert_eq!(flatten_tool_name("namespace:tool/name"), "namespace_tool_name");
/// ```
pub fn flatten_tool_name(name: &str) -> String {
    let flat: String = name
        .chars()
        .map(|c| match c {
            '.' | '/' | ' ' | ':' => '_',
            other => other,
        })
        .collect();
    if flat.chars().count() > 64 {
        flat.chars().take(64).collect()
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_flatten_simple_name() {
        assert_eq!(flatten_tool_name("get_weather"), "get_weather");
    }

    #[test]
    fn test_flatten_namespaced_name() {
        assert_eq!(
            flatten_tool_name("mcp.github.list_repos"),
            "mcp_github_list_repos"
        );
        assert_eq!(
            flatten_tool_name("namespace:tool/name"),
            "namespace_tool_name"
        );
        assert_eq!(flatten_tool_name("my tool name"), "my_tool_name");
    }

    #[test]
    fn test_flatten_truncates_long_name() {
        let long_name = "a".repeat(100);
        let result = flatten_tool_name(&long_name);
        assert_eq!(result.chars().count(), 64);
        assert_eq!(result, "a".repeat(64));
    }

    #[test]
    fn test_flatten_exactly_64_chars() {
        let name = "a".repeat(64);
        let result = flatten_tool_name(&name);
        assert_eq!(result.chars().count(), 64);
        assert_eq!(result, name);
    }

    #[test]
    fn test_flatten_mixed_separators() {
        assert_eq!(
            flatten_tool_name("ns.sub/func:v2 beta"),
            "ns_sub_func_v2_beta"
        );
    }

    #[test]
    fn test_flatten_preserves_other_chars() {
        assert_eq!(flatten_tool_name("get-user_data123"), "get-user_data123");
    }
}
