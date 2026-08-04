//! Compact number formatting for terminal output.
//!
//! The desktop app switches between 万/亿 and K/M/B by locale. The CLI always
//! uses K/M/B: it is shorter, stable across locales, and CLI output is more
//! likely to be read next to other tooling.

pub fn tokens(value: i64) -> String {
    if value < 0 {
        return format!("-{}", tokens(-value));
    }
    const UNITS: [(i64, &str); 3] = [(1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")];
    for (threshold, suffix) in UNITS {
        if value >= threshold {
            let scaled = value as f64 / threshold as f64;
            // Keep it to 3 significant-ish characters: 9.9K, 12K, 123K.
            return if scaled < 10.0 {
                format!("{:.1}{}", scaled, suffix)
            } else {
                format!("{:.0}{}", scaled, suffix)
            };
        }
    }
    value.to_string()
}

/// Truncate to a display width, appending an ellipsis when cut.
pub fn ellipsize(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(1);
    let mut out: String = value.chars().take(keep).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_small_numbers_verbatim() {
        assert_eq!(tokens(0), "0");
        assert_eq!(tokens(999), "999");
    }

    #[test]
    fn formats_thousands_millions_billions() {
        assert_eq!(tokens(1_000), "1.0K");
        assert_eq!(tokens(9_949), "9.9K");
        assert_eq!(tokens(12_300), "12K");
        assert_eq!(tokens(1_500_000), "1.5M");
        assert_eq!(tokens(850_000_000), "850M");
        assert_eq!(tokens(2_400_000_000), "2.4B");
    }

    #[test]
    fn formats_negative_numbers() {
        assert_eq!(tokens(-1_500), "-1.5K");
    }

    #[test]
    fn ellipsize_keeps_short_strings() {
        assert_eq!(ellipsize("abc", 5), "abc");
        assert_eq!(ellipsize("abcde", 5), "abcde");
    }

    #[test]
    fn ellipsize_cuts_long_strings() {
        assert_eq!(ellipsize("abcdefg", 5), "abcd…");
    }

    #[test]
    fn ellipsize_is_char_aware() {
        assert_eq!(ellipsize("供应商密钥模型", 4), "供应商…");
    }
}
