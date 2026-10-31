//! Listener binding and LAN address discovery for the gateway.
//!
//! This module is deliberately Tauri-free: the daemon links `cc_use_lib` and
//! must decide where to bind and which LAN addresses to advertise without a
//! running desktop app. Nothing here reads or writes settings; the caller
//! passes the already-normalized scope.
//!
//! Security model (R8): the default scope is loopback-only. `"lan"` is the only
//! value that binds `0.0.0.0`; every other value, including a missing setting,
//! means `127.0.0.1`. Address discovery is read-only and never returns tokens
//! or file paths.

use crate::models::{ProxyLanAddress, ProxyLanInfo};
use std::net::{Ipv4Addr, SocketAddr};

/// Default listen scope: only this machine can reach the gateway.
pub const LISTEN_SCOPE_LOOPBACK: &str = "loopback";
/// Explicit opt-in that binds every IPv4 interface (`0.0.0.0`).
pub const LISTEN_SCOPE_LAN: &str = "lan";

/// Owned helper for `#[serde(default = ...)]` on `GlobalSettings`.
pub fn default_listen_scope_string() -> String {
    LISTEN_SCOPE_LOOPBACK.to_string()
}

/// Only the exact `"lan"` value enables LAN binding; anything else is loopback.
pub fn normalize_listen_scope(scope: &str) -> &'static str {
    if scope == LISTEN_SCOPE_LAN {
        LISTEN_SCOPE_LAN
    } else {
        LISTEN_SCOPE_LOOPBACK
    }
}

pub fn is_lan_scope(scope: &str) -> bool {
    normalize_listen_scope(scope) == LISTEN_SCOPE_LAN
}

/// Pick the listener address for a normalized (or raw) scope.
///
/// Pure so tests and the daemon agree on the only production binding rule:
/// `lan` => `0.0.0.0:<port>`, everything else => `127.0.0.1:<port>`.
pub fn proxy_bind_address(scope: &str, port: u16) -> SocketAddr {
    let ip = if is_lan_scope(scope) {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    };
    SocketAddr::from((ip, port))
}

/// One IPv4 address found on an interface, before filtering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanCandidate {
    pub ip: Ipv4Addr,
    pub interface: Option<String>,
}

fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    // Loopback, the unspecified address and link-local (`169.254.0.0/16`,
    // e.g. a self-assigned Wi-Fi address) are not reachable from another
    // device. Multicast/broadcast are not peer entry points either.
    !ip.is_unspecified()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_multicast()
        && !ip.is_broadcast()
        && ip.octets()[0] != 0
}

/// Interfaces whose addresses are worth advertising to another device.
///
/// Point-to-point interfaces (VPN/tunnel `utun*`) are excluded on purpose: their
/// "LAN IP" is a tunnel endpoint, not an address a device on the same Wi-Fi can
/// dial, and macOS can even report a network address there (e.g. a /30 tunnel
/// endpoint). Binding the `lan` scope still listens on those interfaces; only
/// the advertised list is filtered.
pub fn is_advertisable_interface_flags(flags: u32) -> bool {
    flags & (libc::IFF_UP as u32) != 0
        && flags & (libc::IFF_LOOPBACK as u32) == 0
        && flags & (libc::IFF_POINTOPOINT as u32) == 0
}

/// Filter, de-duplicate and order whatever the OS enumeration found.
///
/// Kept pure so unit tests can drive it with fake interfaces: the real
/// `getifaddrs` list differs per machine and is not reproducible in CI.
/// Addresses inside the RFC1918 private ranges come first because they are the
/// ones another device on the same home/office network can normally reach.
pub fn collect_lan_addresses(
    candidates: impl IntoIterator<Item = LanCandidate>,
) -> Vec<LanCandidate> {
    let mut seen = std::collections::HashSet::new();
    let mut collected = Vec::new();
    for candidate in candidates {
        if !is_usable_lan_ipv4(candidate.ip) {
            continue;
        }
        // The same address can appear on several interfaces; advertising it
        // twice would produce duplicate copyable URLs.
        if !seen.insert(candidate.ip) {
            continue;
        }
        collected.push(candidate);
    }
    collected.sort_by_key(|candidate| (!candidate.ip.is_private(), u32::from(candidate.ip)));
    collected
}

/// Advertised IPv4 entries for a port. Read-only and side-effect free.
pub fn lan_info(port: u16, scope: &str) -> ProxyLanInfo {
    build_lan_info(port, scope, system_lan_candidates())
}

fn build_lan_info(
    port: u16,
    scope: &str,
    candidates: impl IntoIterator<Item = LanCandidate>,
) -> ProxyLanInfo {
    ProxyLanInfo {
        port,
        scope: normalize_listen_scope(scope).to_string(),
        addresses: collect_lan_addresses(candidates)
            .into_iter()
            .map(|candidate| ProxyLanAddress {
                ip: candidate.ip.to_string(),
                url: format!("http://{}:{}", candidate.ip, port),
                interface: candidate.interface,
            })
            .collect(),
    }
}

#[cfg(unix)]
fn system_lan_candidates() -> Vec<LanCandidate> {
    use std::ffi::CStr;

    let mut candidates = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();

    // SAFETY: `getifaddrs` either fails without writing a list or returns a
    // valid linked list owned by us; it is walked while valid and released
    // exactly once with `freeifaddrs` before returning.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            return candidates;
        }
        let mut entry = head;
        while !entry.is_null() {
            let interface = &*entry;
            if !interface.ifa_addr.is_null() {
                let family = (*interface.ifa_addr).sa_family as i32;
                let flags = interface.ifa_flags;
                if family == libc::AF_INET && is_advertisable_interface_flags(flags) {
                    // `sin_addr.s_addr` is network byte order; converting the
                    // host-order integer with `from_be` yields the right octets
                    // on both little- and big-endian hosts.
                    let address = interface.ifa_addr as *const libc::sockaddr_in;
                    let ip = Ipv4Addr::from(u32::from_be((*address).sin_addr.s_addr));
                    let interface_name = if interface.ifa_name.is_null() {
                        None
                    } else {
                        Some(
                            CStr::from_ptr(interface.ifa_name)
                                .to_string_lossy()
                                .into_owned(),
                        )
                    };
                    candidates.push(LanCandidate {
                        ip,
                        interface: interface_name,
                    });
                }
            }
            entry = interface.ifa_next;
        }
        libc::freeifaddrs(head);
    }

    candidates
}

#[cfg(not(unix))]
fn system_lan_candidates() -> Vec<LanCandidate> {
    // The production targets are macOS/Linux; keep the crate buildable on other
    // platforms without pretending we can enumerate interfaces there.
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(ip: &str, interface: Option<&str>) -> LanCandidate {
        LanCandidate {
            ip: ip.parse().expect("valid test IPv4 address"),
            interface: interface.map(str::to_string),
        }
    }

    #[test]
    fn advertisable_flags_require_up_and_reject_loopback_or_tunnels() {
        let up = libc::IFF_UP as u32;
        let point_to_point = libc::IFF_POINTOPOINT as u32;
        let loopback = libc::IFF_LOOPBACK as u32;
        assert!(is_advertisable_interface_flags(up));
        assert!(is_advertisable_interface_flags(
            up | libc::IFF_BROADCAST as u32
        ));
        assert!(!is_advertisable_interface_flags(up | loopback));
        assert!(!is_advertisable_interface_flags(up | point_to_point));
        assert!(!is_advertisable_interface_flags(point_to_point));
    }

    #[test]
    fn bind_address_is_loopback_unless_scope_is_exactly_lan() {
        assert_eq!(
            proxy_bind_address(LISTEN_SCOPE_LOOPBACK, 12345),
            SocketAddr::from(([127, 0, 0, 1], 12345))
        );
        assert_eq!(
            proxy_bind_address("", 12345),
            SocketAddr::from(([127, 0, 0, 1], 12345))
        );
        assert_eq!(
            proxy_bind_address("LAN", 12345),
            SocketAddr::from(([127, 0, 0, 1], 12345)),
            "only the exact lowercase lan value opts in"
        );
        assert_eq!(
            proxy_bind_address(LISTEN_SCOPE_LAN, 12345),
            SocketAddr::from(([0, 0, 0, 0], 12345))
        );
    }

    #[test]
    fn collector_filters_loopback_link_local_and_unspecified() {
        let collected = collect_lan_addresses(vec![
            candidate("127.0.0.1", Some("lo0")),
            candidate("169.254.10.20", Some("en5")),
            candidate("0.0.0.0", Some("en0")),
            candidate("224.0.0.1", Some("en0")),
            candidate("255.255.255.255", Some("en1")),
            candidate("192.168.1.20", Some("en0")),
        ]);

        let ips: Vec<String> = collected.iter().map(|item| item.ip.to_string()).collect();
        assert_eq!(ips, vec!["192.168.1.20".to_string()]);
        assert_eq!(
            collected[0].interface.as_deref(),
            Some("en0"),
            "the interface name is kept for the copy UI"
        );
    }

    #[test]
    fn collector_orders_private_ranges_first_then_other_addresses() {
        let collected = collect_lan_addresses(vec![
            candidate("203.0.113.7", Some("en1")),
            candidate("10.0.0.5", Some("en0")),
            candidate("172.20.3.4", Some("en0")),
            candidate("100.64.0.9", Some("utun3")),
            candidate("192.168.0.9", Some("en0")),
        ]);

        let ips: Vec<String> = collected.iter().map(|item| item.ip.to_string()).collect();
        assert_eq!(
            ips,
            vec![
                "10.0.0.5".to_string(),
                "172.20.3.4".to_string(),
                "192.168.0.9".to_string(),
                "100.64.0.9".to_string(),
                "203.0.113.7".to_string(),
            ]
        );
    }

    #[test]
    fn collector_dedupes_repeated_addresses_and_keeps_the_first_interface() {
        let collected = collect_lan_addresses(vec![
            candidate("192.168.1.7", Some("en0")),
            candidate("192.168.1.7", Some("en7")),
            candidate("192.168.1.8", None),
        ]);

        assert_eq!(collected.len(), 2);
        assert_eq!(collected[0].interface.as_deref(), Some("en0"));
        assert_eq!(collected[1].interface, None);
    }

    #[test]
    fn lan_info_builds_http_urls_and_normalizes_the_scope() {
        let info = build_lan_info(
            12345,
            LISTEN_SCOPE_LAN,
            vec![candidate("192.168.1.7", Some("en0"))],
        );
        assert_eq!(info.port, 12345);
        assert_eq!(info.scope, LISTEN_SCOPE_LAN);
        assert_eq!(
            info.addresses,
            vec![ProxyLanAddress {
                ip: "192.168.1.7".to_string(),
                url: "http://192.168.1.7:12345".to_string(),
                interface: Some("en0".to_string()),
            }]
        );

        // The info view normalizes too: a bad stored value reports loopback
        // rather than advertising a LAN entry the daemon is not serving.
        for raw_scope in ["LAN", "garbage", "", LISTEN_SCOPE_LOOPBACK] {
            let loopback = build_lan_info(20000, raw_scope, Vec::new());
            assert_eq!(loopback.scope, LISTEN_SCOPE_LOOPBACK);
            assert!(loopback.addresses.is_empty());
        }
    }

    /// The renderer contract is camelCase (`ip`, `url`, `interface`, `port`,
    /// `scope`, `addresses`); a rename here would silently break the copy UI.
    #[test]
    fn lan_info_serializes_to_the_frozen_camel_case_shape() {
        let info = build_lan_info(
            12345,
            LISTEN_SCOPE_LAN,
            vec![candidate("192.168.1.7", Some("en0"))],
        );
        let value = serde_json::to_value(&info).expect("serialize lan info");
        assert_eq!(
            value,
            serde_json::json!({
                "port": 12345,
                "scope": "lan",
                "addresses": [{
                    "ip": "192.168.1.7",
                    "url": "http://192.168.1.7:12345",
                    "interface": "en0",
                }],
            })
        );
    }

    /// Smoke test for the real `getifaddrs` walk: whatever this machine
    /// enumerates must still satisfy the advertised invariants. Machines
    /// without a LAN interface yield an empty list, which is also valid.
    #[test]
    fn system_enumeration_only_yields_usable_unique_addresses() {
        let collected = collect_lan_addresses(system_lan_candidates());
        let unique: std::collections::HashSet<_> =
            collected.iter().map(|candidate| candidate.ip).collect();
        assert_eq!(unique.len(), collected.len(), "advertised IPs are unique");
        for candidate in &collected {
            assert!(!candidate.ip.is_loopback());
            assert!(!candidate.ip.is_link_local());
            assert!(!candidate.ip.is_unspecified());
            assert_ne!(candidate.ip, Ipv4Addr::BROADCAST);
        }
        // Visible with `--nocapture`; useful when a machine shows an
        // unexpected list and contains no secrets.
        println!("system LAN candidates: {:?}", collected);
    }
}
