//! Outbound HTTP for link previews. Members choose the URLs, so the client only reaches public
//! addresses: every hostname goes through a resolver that drops loopback, private, link-local and
//! other special-purpose addresses, and literal IPs are checked before each request and redirect.
//! Without this a post linking to http://169.254.169.254/ or http://localhost:8080/ would have the
//! server fetch it and show the page's text in the preview card.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

const MAX_REDIRECTS: usize = 10;

/// True for addresses on the public internet; false for anything internal or special-purpose.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            !(v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64, may point anywhere in v4
                || s[..6] == [0; 6]) // IPv4-compatible and other ::/96 forms
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (18..20).contains(&b)) // benchmarking
        || a >= 240) // reserved
}

/// Http(s) only, and a literal IP host must be public. Hostnames are checked when they resolve.
pub fn check_url(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("not an http(s) link".into());
    }
    let literal = match url.host() {
        Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
        Some(url::Host::Domain(_)) => None,
        None => return Err("no host".into()),
    };
    match literal {
        Some(ip) if !is_public_ip(ip) => Err("not a public address".into()),
        _ => Ok(()),
    }
}

/// Resolves with the system resolver, keeping only public addresses.
struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| is_public_ip(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(format!("{host} does not resolve to a public address").into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// The client previews are fetched with. No proxy: the address check must see the real target.
pub fn public_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .dns_resolver(Arc::new(PublicResolver))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if let Err(e) = check_url(attempt.url()) {
                attempt.error(e)
            } else {
                attempt.follow()
            }
        }))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn internal_addresses_are_not_public() {
        for s in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe",
        ] {
            assert!(!is_public_ip(ip(s)), "{s} should be rejected");
        }
        for s in ["1.1.1.1", "93.184.215.14", "2606:4700:4700::1111"] {
            assert!(is_public_ip(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn literal_hosts_are_checked() {
        let ok = |u: &str| check_url(&reqwest::Url::parse(u).unwrap()).is_ok();
        assert!(!ok("http://127.0.0.1:8080/api/health"));
        assert!(!ok("http://[::1]/"));
        assert!(!ok("http://169.254.169.254/latest/meta-data/"));
        assert!(!ok("http://2130706433/")); // 127.0.0.1 as a number
        assert!(!ok("file:///etc/passwd"));
        assert!(ok("https://example.com/"));
        assert!(ok("https://1.1.1.1/"));
    }
}
