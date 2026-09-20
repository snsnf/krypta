use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequestParts},
    http::request::Parts,
};
use ipnet::IpNet;

use crate::{error::ApiError, state::AppState};

/*
 * The address every rate limit is keyed on.
 *
 * Behind a reverse proxy the TCP peer is always the proxy, so keyed on that
 * alone every user shares one counter: five failed logins by anyone lock out
 * everyone, and the per-form upload and registration caps become
 * instance-wide. The client address has to come from X-Forwarded-For instead.
 *
 * Trusting that header blindly is the opposite failure: anybody can send one,
 * so every request would arrive from a fresh, invented address and the limits
 * would stop existing. The header is therefore honoured only when the peer is
 * inside TRUSTED_PROXY_CIDRS, and within it only the rightmost address that is
 * not itself a trusted proxy is taken, so a client cannot prepend a value and
 * have it survive a proxy that appends rather than overwrites. With no trusted
 * proxies configured, the peer address is the answer and the header is inert,
 * which is the correct state for local development and the integration suites.
 */
pub struct ClientIp(pub IpAddr);

#[async_trait]
impl FromRequestParts<AppState> for ClientIp {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip())
            .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("peer address unavailable")))?;
        let forwarded_for = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok());
        Ok(ClientIp(resolve_client_ip(
            peer,
            forwarded_for,
            &state.config.trusted_proxy_cidrs,
            &state.trusted_proxy_addresses.snapshot(),
        )))
    }
}

pub fn resolve_client_ip(
    peer: IpAddr,
    forwarded_for: Option<&str>,
    trusted: &[IpNet],
    trusted_addresses: &[IpAddr],
) -> IpAddr {
    let is_trusted =
        |ip: IpAddr| trusted.iter().any(|net| net.contains(&ip)) || trusted_addresses.contains(&ip);
    if !is_trusted(peer) {
        return peer;
    }
    let Some(forwarded_for) = forwarded_for else {
        return peer;
    };
    forwarded_for
        .rsplit(',')
        .filter_map(|entry| entry.trim().parse::<IpAddr>().ok())
        .find(|ip| !is_trusted(*ip))
        .unwrap_or(peer)
}

/*
 * Trusting a proxy by name rather than by network.
 *
 * TRUSTED_PROXY_CIDRS trusts every address in a range. That is right where the
 * range belongs to this deployment alone, as in the standalone production
 * file, and wrong on a network other applications share: under Dokploy the
 * proxy network holds every app on the server, so trusting its subnet let any
 * of them present a fresh client address per request and walk past every
 * address-keyed limit. TRUSTED_PROXY_HOSTS names the proxy container instead,
 * resolved through Docker's DNS, so only the proxy itself is trusted.
 *
 * A name is only as trustworthy as whoever can claim it, and any container on
 * a shared network can give itself a network alias. So a name counts only
 * while it resolves to one address per family. When it suddenly resolves to
 * more, the last unambiguous answer is kept and the ambiguity is logged:
 * trust never widens to a newcomer. When it resolves to nothing, the last
 * answer is kept too, so a proxy restarting does not briefly make every
 * visitor share one counter.
 */
const PROXY_RESOLVE_INTERVAL: Duration = Duration::from_secs(15);

/// The current addresses of the proxies named in `TRUSTED_PROXY_HOSTS`,
/// shared between the resolver task and every request.
#[derive(Clone, Default)]
pub struct TrustedProxyAddresses(Arc<RwLock<Vec<IpAddr>>>);

impl TrustedProxyAddresses {
    pub fn snapshot(&self) -> Vec<IpAddr> {
        // A poisoned lock still holds the last complete list: a writer only
        // ever replaces it whole.
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn replace(&self, addresses: Vec<IpAddr>) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = addresses;
    }
}

/// What a name's latest resolution changes: the new addresses, or `None` to
/// keep the previous ones because the answer was empty or ambiguous.
pub fn accept_resolution(resolved: &[IpAddr]) -> Option<Vec<IpAddr>> {
    let mut unique = resolved.to_vec();
    unique.sort();
    unique.dedup();
    let v4 = unique.iter().filter(|ip| ip.is_ipv4()).count();
    let v6 = unique.len() - v4;
    if unique.is_empty() || v4 > 1 || v6 > 1 {
        return None;
    }
    Some(unique)
}

pub fn parse_trusted_proxy_hosts(raw: &str) -> anyhow::Result<Vec<String>> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let valid = entry.len() <= 253
                && entry
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
            if valid {
                Ok(entry.to_string())
            } else {
                Err(anyhow::anyhow!(
                    "TRUSTED_PROXY_HOSTS entry is not a hostname: {entry}"
                ))
            }
        })
        .collect()
}

/// Keeps `addresses` current for `hosts`. Resolves once before returning, so
/// the first request after startup already trusts the proxy.
pub async fn spawn_proxy_resolver(hosts: Vec<String>, addresses: TrustedProxyAddresses) {
    if hosts.is_empty() {
        return;
    }
    let mut accepted: HashMap<String, Vec<IpAddr>> = HashMap::new();
    refresh(&hosts, &mut accepted, &addresses).await;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(PROXY_RESOLVE_INTERVAL).await;
            refresh(&hosts, &mut accepted, &addresses).await;
        }
    });
}

async fn refresh(
    hosts: &[String],
    accepted: &mut HashMap<String, Vec<IpAddr>>,
    addresses: &TrustedProxyAddresses,
) {
    for host in hosts {
        let resolved: Vec<IpAddr> = match tokio::net::lookup_host((host.as_str(), 0)).await {
            Ok(found) => found.map(|addr| addr.ip()).collect(),
            Err(_) => Vec::new(),
        };
        match accept_resolution(&resolved) {
            Some(next) => {
                accepted.insert(host.clone(), next);
            }
            None if resolved.is_empty() => {
                tracing::warn!(
                    proxy_host = %host,
                    "trusted proxy host did not resolve; keeping its last known address"
                );
            }
            None => {
                tracing::error!(
                    proxy_host = %host,
                    addresses = resolved.len(),
                    "trusted proxy host resolved to more than one address, which another \
                     container claiming its name would cause; keeping its last unambiguous \
                     address and trusting none of the new ones"
                );
            }
        }
    }
    addresses.replace(accepted.values().flatten().copied().collect());
}

pub fn parse_trusted_proxies(raw: &str) -> anyhow::Result<Vec<IpNet>> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            // A bare address is a network of one, so operators can list a
            // single proxy without having to remember the /32 or /128.
            entry
                .parse::<IpNet>()
                .or_else(|_| entry.parse::<IpAddr>().map(IpNet::from))
                .map_err(|_| {
                    anyhow::anyhow!("TRUSTED_PROXY_CIDRS entry is not an address or CIDR: {entry}")
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn trusted() -> Vec<IpNet> {
        parse_trusted_proxies("172.28.0.0/24, 10.0.0.5").unwrap()
    }

    #[test]
    fn without_trusted_proxies_the_header_is_ignored() {
        let resolved = resolve_client_ip(ip("203.0.113.9"), Some("198.51.100.1"), &[], &[]);
        assert_eq!(resolved, ip("203.0.113.9"));
    }

    #[test]
    fn an_untrusted_peer_cannot_forward_an_address() {
        let resolved = resolve_client_ip(ip("203.0.113.9"), Some("198.51.100.1"), &trusted(), &[]);
        assert_eq!(resolved, ip("203.0.113.9"));
    }

    #[test]
    fn a_trusted_peer_yields_the_forwarded_client() {
        let resolved = resolve_client_ip(ip("172.28.0.2"), Some("198.51.100.1"), &trusted(), &[]);
        assert_eq!(resolved, ip("198.51.100.1"));
    }

    #[test]
    fn the_rightmost_untrusted_address_wins_over_a_client_supplied_prefix() {
        // The client sent its own X-Forwarded-For; the appending proxy added
        // the real address behind it, then a second trusted hop added itself.
        let resolved = resolve_client_ip(
            ip("172.28.0.2"),
            Some("1.2.3.4, 198.51.100.1, 10.0.0.5"),
            &trusted(),
            &[],
        );
        assert_eq!(resolved, ip("198.51.100.1"));
    }

    #[test]
    fn garbage_in_the_header_falls_back_to_the_peer() {
        let resolved = resolve_client_ip(ip("172.28.0.2"), Some("not-an-ip"), &trusted(), &[]);
        assert_eq!(resolved, ip("172.28.0.2"));
        let resolved = resolve_client_ip(ip("172.28.0.2"), None, &trusted(), &[]);
        assert_eq!(resolved, ip("172.28.0.2"));
    }

    #[test]
    fn a_bare_address_is_accepted_as_a_network_of_one() {
        let nets = parse_trusted_proxies("10.0.0.5").unwrap();
        assert!(nets[0].contains(&ip("10.0.0.5")));
        assert!(!nets[0].contains(&ip("10.0.0.6")));
        assert!(parse_trusted_proxies("nope").is_err());
        assert!(parse_trusted_proxies("").unwrap().is_empty());
    }

    #[test]
    fn a_resolved_proxy_address_is_trusted_without_its_network() {
        let proxy = ip("172.18.0.7");
        let neighbour = ip("172.18.0.9");
        assert_eq!(
            resolve_client_ip(proxy, Some("198.51.100.1"), &[], &[proxy]),
            ip("198.51.100.1")
        );
        assert_eq!(
            resolve_client_ip(neighbour, Some("198.51.100.1"), &[], &[proxy]),
            neighbour,
            "another container on the same network must not be able to forward an address"
        );
    }

    #[test]
    fn a_name_is_trusted_only_while_it_resolves_unambiguously() {
        assert_eq!(
            accept_resolution(&[ip("172.18.0.7")]),
            Some(vec![ip("172.18.0.7")])
        );
        assert_eq!(
            accept_resolution(&[ip("172.18.0.7"), ip("fd00::7")]),
            Some(vec![ip("172.18.0.7"), ip("fd00::7")]),
            "one address per family is one proxy"
        );
        assert_eq!(
            accept_resolution(&[ip("172.18.0.7"), ip("172.18.0.7")]),
            Some(vec![ip("172.18.0.7")])
        );
        assert_eq!(
            accept_resolution(&[ip("172.18.0.7"), ip("172.18.0.9")]),
            None,
            "a second container claiming the name must not become trusted"
        );
        assert_eq!(accept_resolution(&[]), None);
    }

    #[tokio::test]
    async fn a_name_that_stops_resolving_keeps_its_last_address() {
        let addresses = TrustedProxyAddresses::default();
        let mut accepted = HashMap::new();
        // "localhost" resolves on every machine, to one address per family.
        refresh(&["localhost".to_string()], &mut accepted, &addresses).await;
        let first = addresses.snapshot();
        assert!(!first.is_empty());
        // A name that resolves to nothing leaves the trusted list as it was.
        accepted.insert("gone.invalid".to_string(), vec![]);
        refresh(&["gone.invalid".to_string()], &mut accepted, &addresses).await;
        assert!(first.iter().all(|ip| addresses.snapshot().contains(ip)));
    }

    #[test]
    fn proxy_host_names_are_validated() {
        assert_eq!(
            parse_trusted_proxy_hosts("dokploy-traefik, proxy.internal").unwrap(),
            vec!["dokploy-traefik", "proxy.internal"]
        );
        assert!(parse_trusted_proxy_hosts("").unwrap().is_empty());
        assert!(parse_trusted_proxy_hosts("bad host").is_err());
    }
}
