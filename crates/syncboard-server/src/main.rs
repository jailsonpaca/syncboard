use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use syncboard_core::http::{create_router, AppState, ServerPaths};
use syncboard_core::hub::Hub;
use syncboard_core::migration::{discover_legacy_sources, migrate_legacy_data};
use syncboard_core::pair::PairService;
use syncboard_core::store::ClipStore;
use syncboard_core::update::UpdateChecker;

fn default_data_dir() -> PathBuf {
    if let Ok(v) = std::env::var("SYNCBOARD_DATA") {
        return PathBuf::from(v);
    }
    if let Ok(cwd) = std::env::current_dir() {
        let candidate = cwd.join("server").join("data");
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("data")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();
    let data_dir = default_data_dir();
    let store = Arc::new(ClipStore::open(&data_dir)?);

    // Subcomando opcional: `syncboard-server migrate`
    if args.get(1).map(String::as_str) == Some("migrate") {
        let force = args.iter().any(|a| a == "--force");
        let sources = discover_legacy_sources(None);
        let cfg_target = data_dir
            .parent()
            .unwrap_or(&data_dir)
            .join("config.json");
        let report = migrate_legacy_data(&store, &cfg_target, &sources, force)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787);
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());

    let hub = Arc::new(Hub::new());
    let pair = PairService::new(port);
    let updater = Arc::new(UpdateChecker::new(env!("CARGO_PKG_VERSION")));

    let client_dist = std::env::var("SYNCBOARD_CLIENT_DIST")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let p = PathBuf::from("client/dist");
            p.exists().then_some(p)
        });
    let release_dir = std::env::var("SYNCBOARD_RELEASE_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            let p = PathBuf::from("desktop/release");
            p.exists().then_some(p)
        });

    let app = create_router(
        AppState {
            store,
            hub,
            pair: Some(Arc::clone(&pair)),
            updater,
        },
        ServerPaths {
            client_dist,
            release_dir,
        },
    );

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    let info = pair.get_info();
    pair.start_beacon();

    println!("\n  SyncBoard Server (Rust v{})", env!("CARGO_PKG_VERSION"));
    println!("  Local:  http://localhost:{port}");
    println!("  Rede:   {}", info.url);
    println!("  Código: {}\n", info.code);

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            pair.stop_beacon();
        })
        .await?;

    Ok(())
}
