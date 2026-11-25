//! Watcher da área de transferência no Linux/X11 via XFixes.
//!
//! Substitui `ClipboardWatcherContext::start_watch` da clipboard-rs, que usa `expect`/`unwrap`
//! (com `panic = "abort"` qualquer falha de X derrubava o app inteiro) e só processa um evento a
//! cada 500 ms. Aqui:
//! - uma única conexão X, bloqueada em `wait_for_event` (zero CPU em repouso);
//! - erros viram `Err`, registrados no log, e o watcher é reiniciado com backoff;
//! - não lê o conteúdo: só avisa que o dono da seleção CLIPBOARD mudou.

use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedSender;
use x11rb::connection::Connection;
use x11rb::protocol::xfixes::{self, ConnectionExt as _, SelectionEventMask};
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::Event;

/// Inicia a thread do watcher. Termina só quando o receptor do canal for descartado.
pub fn spawn(tx: UnboundedSender<()>) {
    let res = std::thread::Builder::new()
        .name("syncboard-x11-watch".into())
        .spawn(move || {
            let mut backoff = Duration::from_secs(1);
            loop {
                let started = Instant::now();
                match run_once(&tx) {
                    Ok(()) => {
                        tracing::info!("[clipboard] watcher X11 encerrado (app saindo)");
                        return;
                    }
                    Err(e) => {
                        tracing::error!("[clipboard] watcher X11 falhou: {e}; reiniciando em {backoff:?}");
                    }
                }
                if started.elapsed() > Duration::from_secs(60) {
                    backoff = Duration::from_secs(1);
                }
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                // Força uma leitura ao voltar: algo pode ter sido copiado enquanto estava parado.
                if tx.send(()).is_err() {
                    return;
                }
            }
        });
    if let Err(e) = res {
        tracing::error!("[clipboard] não foi possível criar a thread do watcher X11: {e}");
    }
}

fn run_once(tx: &UnboundedSender<()>) -> Result<(), String> {
    let (conn, screen_num) = x11rb::connect(None).map_err(|e| format!("connect: {e}"))?;
    let root = conn
        .setup()
        .roots
        .get(screen_num)
        .ok_or("tela X inexistente")?
        .root;

    xfixes::query_version(&conn, 5, 0)
        .map_err(|e| format!("xfixes: {e}"))?
        .reply()
        .map_err(|e| format!("xfixes indisponível: {e}"))?;

    let clipboard = conn
        .intern_atom(false, b"CLIPBOARD")
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom;

    conn.xfixes_select_selection_input(
        root,
        clipboard,
        SelectionEventMask::SET_SELECTION_OWNER
            | SelectionEventMask::SELECTION_CLIENT_CLOSE
            | SelectionEventMask::SELECTION_WINDOW_DESTROY,
    )
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| format!("select_selection_input: {e}"))?;

    tracing::info!("[clipboard] watcher X11 (XFixes) ativo");

    loop {
        let event = conn
            .wait_for_event()
            .map_err(|e| format!("conexão X perdida: {e}"))?;
        if let Event::XfixesSelectionNotify(ev) = event {
            if ev.selection == clipboard && tx.send(()).is_err() {
                return Ok(());
            }
        }
    }
}
