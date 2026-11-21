use std::collections::HashMap;

use crate::models::DeviceInfo;

/// Agrupa variantes tipo "Pixel-a1b2" / "Pixel-c3d4" geradas em reconexões.
fn device_base_key(name: &str) -> String {
    let trimmed = name.trim();
    if let Some((prefix, suffix)) = trimmed.rsplit_once('-') {
        if suffix.len() == 4 && suffix.chars().all(|c| c.is_ascii_alphanumeric()) {
            return prefix.to_lowercase();
        }
    }
    trimmed.to_lowercase()
}

/// Deduplica dispositivos:
/// 1) mesmo nome (case-insensitive)
/// 2) variantes com sufixo aleatório de 4 chars — mantém online(s) ou o mais curto
pub fn dedupe_devices(devices: Vec<DeviceInfo>) -> Vec<DeviceInfo> {
    let mut by_exact: HashMap<String, DeviceInfo> = HashMap::new();
    for d in devices {
        let name = d.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let key = name.to_lowercase();
        match by_exact.get_mut(&key) {
            None => {
                by_exact.insert(
                    key,
                    DeviceInfo {
                        name,
                        online: d.online,
                    },
                );
            }
            Some(prev) => {
                if d.online && !prev.online {
                    *prev = DeviceInfo { name, online: true };
                } else if d.online {
                    prev.online = true;
                }
            }
        }
    }

    let mut groups: HashMap<String, Vec<DeviceInfo>> = HashMap::new();
    for d in by_exact.into_values() {
        let base = device_base_key(&d.name);
        groups.entry(base).or_default().push(d);
    }

    let mut result: Vec<DeviceInfo> = Vec::new();
    for (_, mut group) in groups {
        if group.len() == 1 {
            result.push(group.remove(0));
            continue;
        }
        let online: Vec<DeviceInfo> = group.iter().filter(|d| d.online).cloned().collect();
        if !online.is_empty() {
            result.extend(online);
        } else {
            group.sort_by(|a, b| a.name.len().cmp(&b.name.len()).then_with(|| a.name.cmp(&b.name)));
            result.push(group.remove(0));
        }
    }

    result.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_case_and_random_suffix() {
        let out = dedupe_devices(vec![
            DeviceInfo { name: "Pixel-a1b2".into(), online: false },
            DeviceInfo { name: "Pixel-c3d4".into(), online: true },
            DeviceInfo { name: "Mac".into(), online: false },
            DeviceInfo { name: "mac".into(), online: true },
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], DeviceInfo { name: "mac".into(), online: true });
        assert_eq!(out[1], DeviceInfo { name: "Pixel-c3d4".into(), online: true });
    }
}
