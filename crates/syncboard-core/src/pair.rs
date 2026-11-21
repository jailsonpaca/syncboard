use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::Rng;
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tokio::sync::watch;

pub const PAIR_MULTICAST: &str = "239.255.77.87";
pub const PAIR_UDP_PORT: u16 = 18787;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

fn random_code(len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| {
            let idx = rng.gen_range(0..CODE_ALPHABET.len());
            CODE_ALPHABET[idx] as char
        })
        .collect()
}

fn random_hex(bytes: usize) -> String {
    let mut rng = rand::thread_rng();
    let buf: Vec<u8> = (0..bytes).map(|_| rng.gen::<u8>()).collect();
    hex::encode(buf)
}

pub fn get_lan_ipv4() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let IpAddr::V4(v4) = iface.ip() {
                if !v4.is_loopback() && !v4.is_link_local() {
                    let s = v4.to_string();
                    if !ips.contains(&s) {
                        ips.push(s);
                    }
                }
            }
        }
    }
    ips
}

pub fn get_local_ip() -> String {
    get_lan_ipv4()
        .into_iter()
        .next()
        .unwrap_or_else(|| "127.0.0.1".to_string())
}

pub fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "SyncBoard".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairInfo {
    pub code: String,
    pub url: String,
    pub urls: Vec<String>,
    pub token: String,
    pub qr_payload: String,
    pub join_url: String,
    pub udp_port: u16,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairJoinResult {
    pub server_url: String,
    pub token: String,
    pub urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub server_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct ParsedJoinPayload {
    pub server_url: Option<String>,
    pub code: Option<String>,
}

struct PairState {
    code: String,
    token: String,
}

pub struct PairService {
    http_port: u16,
    state: Mutex<PairState>,
    stop_tx: Mutex<Option<watch::Sender<bool>>>,
}

impl PairService {
    pub fn new(http_port: u16) -> Arc<Self> {
        Arc::new(Self {
            http_port,
            state: Mutex::new(PairState {
                code: random_code(6),
                token: random_hex(16),
            }),
            stop_tx: Mutex::new(None),
        })
    }

    pub fn regenerate(&self) -> PairInfo {
        {
            let mut st = self.state.lock().unwrap();
            st.code = random_code(6);
            st.token = random_hex(16);
        }
        self.get_info()
    }

    pub fn lan_urls(&self) -> Vec<String> {
        let ips = get_lan_ipv4();
        if ips.is_empty() {
            vec![format!("http://127.0.0.1:{}", self.http_port)]
        } else {
            ips.into_iter()
                .map(|ip| format!("http://{ip}:{}", self.http_port))
                .collect()
        }
    }

    pub fn get_info(&self) -> PairInfo {
        let (code, token) = {
            let st = self.state.lock().unwrap();
            (st.code.clone(), st.token.clone())
        };
        let urls = self.lan_urls();
        let url = urls[0].clone();
        let qr_payload = format!(
            "syncboard://join?url={}&code={code}",
            urlencoding::encode(&url)
        );
        PairInfo {
            join_url: format!("{url}/?join={code}"),
            code,
            url,
            urls,
            token,
            qr_payload,
            udp_port: PAIR_UDP_PORT,
            hostname: get_hostname(),
        }
    }

    pub fn join(&self, raw_code: &str) -> Option<PairJoinResult> {
        let normalized: String = raw_code
            .trim()
            .to_uppercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect();
        let st = self.state.lock().unwrap();
        if normalized.is_empty() || normalized != st.code {
            return None;
        }
        let urls = self.lan_urls();
        Some(PairJoinResult {
            server_url: urls[0].clone(),
            token: st.token.clone(),
            urls,
        })
    }

    fn beacon_payload(&self) -> Vec<u8> {
        let info = self.get_info();
        serde_json::to_vec(&serde_json::json!({
            "type": "syncboard-pair",
            "v": 1,
            "code": info.code,
            "url": info.url,
            "urls": info.urls,
            "token": info.token,
            "hostname": info.hostname,
        }))
        .unwrap_or_default()
    }

    pub fn start_beacon(self: &Arc<Self>) {
        let mut guard = self.stop_tx.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let (tx, mut rx) = watch::channel(false);
        *guard = Some(tx);
        drop(guard);

        let svc = Arc::clone(self);
        tokio::spawn(async move {
            let socket = match create_reuse_udp_socket(PAIR_UDP_PORT, true) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("[pair] udp bind falhou: {e}");
                    return;
                }
            };
            let multicast_addr: SocketAddr =
                SocketAddr::V4(SocketAddrV4::new(PAIR_MULTICAST.parse().unwrap(), PAIR_UDP_PORT));

            let mut buf = [0u8; 4096];
            let mut ticker = tokio::time::interval(Duration::from_secs(2));

            loop {
                tokio::select! {
                    _ = rx.changed() => {
                        if *rx.borrow() { break; }
                    }
                    _ = ticker.tick() => {
                        let payload = svc.beacon_payload();
                        let _ = socket.send_to(&payload, multicast_addr).await;
                    }
                    res = socket.recv_from(&mut buf) => {
                        let Ok((n, peer)) = res else { continue };
                        let Ok(val) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else { continue };
                        let msg_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if msg_type == "syncboard-discover" {
                            let payload = svc.beacon_payload();
                            let _ = socket.send_to(&payload, peer).await;
                        } else if msg_type == "syncboard-pair-query" {
                            if let Some(code) = val.get("code").and_then(|v| v.as_str()) {
                                if svc.join(code).is_some() {
                                    let payload = svc.beacon_payload();
                                    let _ = socket.send_to(&payload, peer).await;
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    pub fn stop_beacon(&self) {
        if let Some(tx) = self.stop_tx.lock().unwrap().take() {
            let _ = tx.send(true);
        }
    }
}

fn create_reuse_udp_socket(port: u16, join_multicast: bool) -> std::io::Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    #[cfg(unix)]
    let _ = sock.set_reuse_port(true);
    let addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port);
    sock.bind(&addr.into())?;
    let _ = sock.set_broadcast(true);
    let _ = sock.set_multicast_ttl_v4(1);
    if join_multicast {
        let mcast: Ipv4Addr = PAIR_MULTICAST.parse().unwrap();
        let _ = sock.join_multicast_v4(&mcast, &Ipv4Addr::UNSPECIFIED);
    }
    sock.set_nonblocking(true)?;
    UdpSocket::from_std(sock.into())
}

pub fn parse_join_payload(raw: &str) -> Option<ParsedJoinPayload> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }

    if let Some(rest) = text.strip_prefix("syncboard://") {
        let query = rest.split_once('?').map(|(_, q)| q).unwrap_or("");
        let mut server_url = None;
        let mut code = None;
        for part in query.split('&') {
            if let Some((k, v)) = part.split_once('=') {
                let decoded = urlencoding::decode(v).ok().map(|s| s.into_owned()).unwrap_or_else(|| v.to_string());
                if k == "url" && !decoded.is_empty() {
                    server_url = Some(decoded.trim_end_matches('/').to_string());
                } else if k == "code" && !decoded.is_empty() {
                    code = Some(decoded);
                }
            }
        }
        if server_url.is_some() {
            return Some(ParsedJoinPayload { server_url, code });
        }
    }

    if text.starts_with("http://") || text.starts_with("https://") {
        let (base, query) = text.split_once('?').unwrap_or((text, ""));
        // Keep scheme + host[:port]
        let scheme_end = base.find("://")? + 3;
        let host_end = base[scheme_end..].find('/').map(|i| scheme_end + i).unwrap_or(base.len());
        let server_url = base[..host_end].trim_end_matches('/').to_string();
        let mut code = None;
        for part in query.split('&') {
            if let Some(("join", v)) = part.split_once('=') {
                if !v.is_empty() {
                    code = Some(v.to_string());
                }
            }
        }
        return Some(ParsedJoinPayload {
            server_url: Some(server_url),
            code,
        });
    }

    if (4..=8).contains(&text.len()) && text.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(ParsedJoinPayload {
            server_url: None,
            code: Some(text.to_uppercase()),
        });
    }

    None
}

pub async fn discover_by_code(code: &str, timeout: Duration) -> Result<PairJoinResult, String> {
    let normalized: String = code
        .trim()
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if normalized.len() < 4 {
        return Err("Código inválido".to_string());
    }

    let socket = create_reuse_udp_socket(PAIR_UDP_PORT, true)
        .or_else(|_| create_reuse_udp_socket(0, false))
        .map_err(|e| format!("Falha ao abrir socket UDP: {e}"))?;

    let query = serde_json::to_vec(&serde_json::json!({
        "type": "syncboard-pair-query",
        "code": normalized,
    }))
    .unwrap();

    let mcast: SocketAddr = format!("{PAIR_MULTICAST}:{PAIR_UDP_PORT}").parse().unwrap();
    let bcast: SocketAddr = format!("255.255.255.255:{PAIR_UDP_PORT}").parse().unwrap();
    let _ = socket.send_to(&query, mcast).await;
    let _ = socket.send_to(&query, bcast).await;

    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + timeout;

    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err("Nenhum servidor encontrado com este código na rede local".to_string());
        }
        let rem = deadline - now;
        match tokio::time::timeout(rem, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => {
                let Ok(val) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) else {
                    continue;
                };
                if val.get("type").and_then(|v| v.as_str()) != Some("syncboard-pair") {
                    continue;
                }
                let got_code = val
                    .get("code")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_uppercase();
                if got_code != normalized {
                    continue;
                }
                let Some(url) = val.get("url").and_then(|v| v.as_str()) else {
                    continue;
                };
                let urls = val
                    .get("urls")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.trim_end_matches('/').to_string()))
                            .collect()
                    })
                    .unwrap_or_else(|| vec![url.trim_end_matches('/').to_string()]);
                let token = val
                    .get("token")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                return Ok(PairJoinResult {
                    server_url: url.trim_end_matches('/').to_string(),
                    token,
                    urls,
                });
            }
            Ok(Err(e)) => return Err(format!("Erro UDP: {e}")),
            Err(_) => {
                return Err("Nenhum servidor encontrado com este código na rede local".to_string());
            }
        }
    }
}

pub async fn discover_servers(timeout: Duration) -> Vec<DiscoveredServer> {
    let found = Arc::new(Mutex::new(HashMap::<String, DiscoveredServer>::new()));

    let f_udp = Arc::clone(&found);
    let udp_task = tokio::spawn(async move {
        let Ok(socket) = create_reuse_udp_socket(0, false) else {
            return;
        };
        let query = serde_json::to_vec(&serde_json::json!({
            "type": "syncboard-discover",
            "v": 1,
        }))
        .unwrap();

        let mut dests = vec![
            PAIR_MULTICAST.to_string(),
            "255.255.255.255".to_string(),
            "127.0.0.1".to_string(),
        ];
        dests.extend(get_lan_ipv4());
        let unique_dests: HashSet<String> = dests.into_iter().collect();
        for host in &unique_dests {
            if let Ok(addr) = format!("{host}:{PAIR_UDP_PORT}").parse::<SocketAddr>() {
                let _ = socket.send_to(&query, addr).await;
            }
        }

        let mut buf = [0u8; 4096];
        let deadline = tokio::time::Instant::now() + timeout.min(Duration::from_millis(2500));
        while tokio::time::Instant::now() < deadline {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(rem, socket.recv_from(&mut buf)).await {
                Ok(Ok((n, _))) => {
                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&buf[..n]) {
                        if val.get("type").and_then(|v| v.as_str()) == Some("syncboard-pair") {
                            merge_server(&f_udp, &val, None);
                        }
                    }
                }
                _ => break,
            }
        }
    });

    let f_http = Arc::clone(&found);
    let http_task = tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(300))
            .build()
            .ok();
        let Some(client) = client else { return };

        let mut hosts: Vec<String> = vec!["127.0.0.1".to_string()];
        for ip in get_lan_ipv4() {
            hosts.push(ip.clone());
            let parts: Vec<&str> = ip.split('.').collect();
            if parts.len() == 4 {
                for last in 1..=254u8 {
                    let cand = format!("{}.{}.{}.{}", parts[0], parts[1], parts[2], last);
                    if !hosts.contains(&cand) {
                        hosts.push(cand);
                    }
                }
            }
        }

        let started = tokio::time::Instant::now();
        for chunk in hosts.chunks(40) {
            if started.elapsed() > timeout {
                break;
            }
            let mut futs = Vec::with_capacity(chunk.len());
            for host in chunk {
                let base = format!("http://{host}:8787");
                let c = client.clone();
                let fh = Arc::clone(&f_http);
                futs.push(async move {
                    if let Ok(res) = c.get(format!("{base}/api/pair")).send().await {
                        if res.status().is_success() {
                            if let Ok(val) = res.json::<serde_json::Value>().await {
                                merge_server(&fh, &val, Some(&base));
                            }
                        }
                    }
                });
            }
            futures_util::future::join_all(futs).await;
            if !f_http.lock().unwrap().is_empty() && started.elapsed() > Duration::from_millis(700) {
                break;
            }
        }
    });

    let _ = tokio::join!(udp_task, http_task);
    let mut list: Vec<DiscoveredServer> = found.lock().unwrap().values().cloned().collect();
    list.sort_by(|a, b| a.server_url.cmp(&b.server_url));
    list
}

fn merge_server(
    map: &Mutex<HashMap<String, DiscoveredServer>>,
    val: &serde_json::Value,
    fallback_url: Option<&str>,
) {
    let raw_url = val
        .get("url")
        .or_else(|| val.get("serverUrl"))
        .and_then(|v| v.as_str())
        .or(fallback_url);
    let Some(raw_url) = raw_url else { return };
    let server_url = raw_url.trim_end_matches('/').to_string();
    if server_url.is_empty() {
        return;
    }

    let mut m = map.lock().unwrap();
    let prev = m.get(&server_url).cloned();
    let code = val
        .get("code")
        .and_then(|v| v.as_str())
        .map(|s| s.to_uppercase())
        .or_else(|| prev.as_ref().and_then(|p| p.code.clone()));
    let hostname = val
        .get("hostname")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| prev.as_ref().and_then(|p| p.hostname.clone()));
    let urls = val
        .get("urls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim_end_matches('/').to_string()))
                .collect()
        })
        .or_else(|| prev.and_then(|p| p.urls));

    m.insert(
        server_url.clone(),
        DiscoveredServer {
            server_url,
            code,
            hostname,
            urls,
        },
    );
}
