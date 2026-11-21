use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use uuid::Uuid;

use crate::devices::dedupe_devices;
use crate::hub::Hub;
use crate::models::{
    ClipItem, DeviceInfo, ItemType, ListFilter, ListOptions, SyncSnapshot, WsMessage,
    MAX_FILE_UPLOAD_BYTES, MAX_HISTORY_ITEMS,
};
use crate::pair::PairService;
use crate::store::{ClipStore, CreateItemInput, UpdateItemFields};
use crate::update::UpdateChecker;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<ClipStore>,
    pub hub: Arc<Hub>,
    pub pair: Option<Arc<PairService>>,
    pub updater: Arc<UpdateChecker>,
}

pub struct ServerPaths {
    pub client_dist: Option<PathBuf>,
    pub release_dir: Option<PathBuf>,
}

pub fn create_router(state: AppState, paths: ServerPaths) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .route("/update", get(update_status))
        .route("/pair", get(pair_info))
        .route("/pair/regenerate", post(pair_regenerate))
        .route("/pair/join", post(pair_join))
        .route("/devices", get(list_devices))
        .route("/items", get(list_items))
        .route("/items/text", post(create_text).layer(DefaultBodyLimit::max(10 * 1024 * 1024)))
        .route(
            "/items/upload",
            post(upload_multipart).layer(DefaultBodyLimit::max(MAX_FILE_UPLOAD_BYTES + 10 * 1024 * 1024)),
        )
        .route(
            "/items/upload-base64",
            post(upload_base64).layer(DefaultBodyLimit::max(60 * 1024 * 1024)),
        )
        .route("/items/{id}", get(get_item).patch(patch_item).delete(delete_item))
        .route("/items/{id}/blob", get(get_item_blob))
        .route("/items/{id}/touch", post(touch_item));

    let mut router = Router::new()
        .nest("/api", api)
        .route("/ws", get(ws_handler))
        .with_state(state);

    if let Some(release_dir) = paths.release_dir {
        if release_dir.is_dir() {
            router = router.nest_service("/downloads", ServeDir::new(release_dir));
        }
    }

    if let Some(client_dist) = paths.client_dist {
        let index = client_dist.join("index.html");
        if client_dist.is_dir() && index.is_file() {
            let service = ServeDir::new(client_dist).not_found_service(ServeFile::new(index));
            router = router.fallback_service(service);
        }
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    router.layer(cors)
}

fn json_error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

async fn health(State(st): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "service": "syncboard",
        "version": st.updater.current_version(),
    }))
}

async fn version(State(st): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({ "version": st.updater.current_version() }))
}

#[derive(Deserialize)]
struct UpdateQuery {
    force: Option<String>,
}

async fn update_status(
    State(st): State<AppState>,
    Query(q): Query<UpdateQuery>,
) -> impl IntoResponse {
    let force = q.force.as_deref() == Some("true");
    let status = st.updater.get_status(force).await;
    Json(status)
}

async fn pair_info(State(st): State<AppState>) -> Response {
    match &st.pair {
        Some(p) => Json(p.get_info()).into_response(),
        None => json_error(StatusCode::SERVICE_UNAVAILABLE, "Pareamento indisponível"),
    }
}

async fn pair_regenerate(State(st): State<AppState>) -> Response {
    match &st.pair {
        Some(p) => Json(p.regenerate()).into_response(),
        None => json_error(StatusCode::SERVICE_UNAVAILABLE, "Pareamento indisponível"),
    }
}

#[derive(Deserialize)]
struct PairJoinBody {
    code: Option<String>,
}

async fn pair_join(State(st): State<AppState>, Json(body): Json<PairJoinBody>) -> Response {
    let Some(pair) = &st.pair else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Pareamento indisponível");
    };
    let code = body.code.unwrap_or_default();
    match pair.join(&code) {
        Some(res) => Json(res).into_response(),
        None => json_error(StatusCode::NOT_FOUND, "Código inválido ou expirado"),
    }
}

async fn list_devices(State(st): State<AppState>) -> Response {
    let known = st.store.list_device_names().unwrap_or_default();
    let online_vec = st.hub.online_device_names();
    let online_set: HashSet<String> = online_vec.iter().cloned().collect();

    let mut all_names: HashSet<String> = known.into_iter().collect();
    for name in online_vec {
        all_names.insert(name);
    }

    let devices = dedupe_devices(
        all_names
            .into_iter()
            .map(|name| {
                let is_on = online_set.contains(&name);
                DeviceInfo { name, online: is_on }
            })
            .collect(),
    );

    Json(serde_json::json!({ "devices": devices })).into_response()
}

#[derive(Deserialize)]
struct ListItemsQuery {
    pinned: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
    q: Option<String>,
    #[serde(rename = "type")]
    filter_type: Option<String>,
    device: Option<String>,
    flat: Option<String>,
}

async fn list_items(
    State(st): State<AppState>,
    Query(q): Query<ListItemsQuery>,
) -> Response {
    let pinned = q.pinned.as_deref() == Some("true");
    let default_limit = if pinned { 100 } else { 20 };
    let limit = q
        .limit
        .as_deref()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(default_limit)
        .min(MAX_HISTORY_ITEMS);
    let offset = q
        .offset
        .as_deref()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    let flat = q.flat.as_deref() == Some("true");

    let opts = ListOptions {
        pinned_only: pinned,
        limit: Some(limit),
        offset: Some(offset),
        query: q.q,
        filter: ListFilter::parse(q.filter_type.as_deref()),
        device_name: q.device.filter(|s| !s.trim().is_empty()),
    };

    match st.store.list_page(opts) {
        Ok(res) => {
            if flat {
                Json(res.items).into_response()
            } else {
                Json(res).into_response()
            }
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_item(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.store.get(&id) {
        Ok(Some(item)) => Json(item).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Item não encontrado"),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_item_blob(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let item = match st.store.get(&id) {
        Ok(Some(item)) if item.item_type != ItemType::Text => item,
        Ok(_) => return json_error(StatusCode::NOT_FOUND, "Blob não encontrado"),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };

    let Some(blob_path) = st.store.get_blob_path(&item.id) else {
        return json_error(StatusCode::NOT_FOUND, "Arquivo não encontrado no disco");
    };

    let file = match tokio::fs::File::open(&blob_path).await {
        Ok(f) => f,
        Err(_) => return json_error(StatusCode::NOT_FOUND, "Arquivo não encontrado no disco"),
    };

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);
    let mut resp = Response::new(body);

    let mime = item
        .mime_type
        .as_deref()
        .unwrap_or("application/octet-stream");
    if let Ok(v) = HeaderValue::from_str(mime) {
        resp.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    if let Some(filename) = &item.filename {
        let disp = format!("inline; filename=\"{}\"", urlencoding::encode(filename));
        if let Ok(v) = HeaderValue::from_str(&disp) {
            resp.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    resp
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTextBody {
    content: Option<String>,
    pinned: Option<bool>,
    label: Option<String>,
    device_name: Option<String>,
}

async fn create_text(State(st): State<AppState>, Json(body): Json<CreateTextBody>) -> Response {
    let Some(content) = body.content else {
        return json_error(StatusCode::BAD_REQUEST, "Conteúdo de texto obrigatório");
    };
    if content.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Conteúdo de texto obrigatório");
    }

    let size = content.len() as i64;
    let res = st.store.create(CreateItemInput {
        id: Uuid::new_v4().to_string(),
        item_type: ItemType::Text,
        content: Some(content),
        filename: None,
        mime_type: Some("text/plain".to_string()),
        size,
        pinned: body.pinned.unwrap_or(false),
        label: body.label.filter(|s| !s.is_empty()),
        device_name: body.device_name.filter(|s| !s.is_empty()),
        created_at: None,
        updated_at: None,
    });

    match res {
        Ok(created) => {
            for trimmed_id in created.trimmed_ids {
                st.hub.notify_item_deleted(trimmed_id);
            }
            st.hub.notify_item_created(created.item.clone());
            (StatusCode::CREATED, Json(created.item)).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn upload_multipart(State(st): State<AppState>, mut multipart: Multipart) -> Response {
    let id = Uuid::new_v4().to_string();
    let blob_path = st.store.blob_path(&id);

    let mut pinned = false;
    let mut label: Option<String> = None;
    let mut device_name: Option<String> = None;
    let mut filename: Option<String> = None;
    let mut mime_type: Option<String> = None;
    let mut file_size: i64 = 0;
    let mut got_file = false;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            filename = field.file_name().map(|s| s.to_string());
            mime_type = field.content_type().map(|s| s.to_string());

            let mut file = match tokio::fs::File::create(&blob_path).await {
                Ok(f) => f,
                Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };

            let mut total: usize = 0;
            while let Ok(Some(chunk)) = field.chunk().await {
                total += chunk.len();
                if total > MAX_FILE_UPLOAD_BYTES {
                    let _ = tokio::fs::remove_file(&blob_path).await;
                    return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Arquivo excede limite de 200 MB");
                }
                if let Err(e) = file.write_all(&chunk).await {
                    let _ = tokio::fs::remove_file(&blob_path).await;
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
                }
            }
            let _ = file.flush().await;
            file_size = total as i64;
            got_file = true;
        } else if let Ok(text) = field.text().await {
            match name.as_str() {
                "pinned" => pinned = text == "true",
                "label" if !text.is_empty() => label = Some(text),
                "deviceName" if !text.is_empty() => device_name = Some(text),
                "filename" if filename.is_none() && !text.is_empty() => filename = Some(text),
                _ => {}
            }
        }
    }

    if !got_file {
        let _ = tokio::fs::remove_file(&blob_path).await;
        return json_error(StatusCode::BAD_REQUEST, "Arquivo obrigatório");
    }

    let resolved_mime = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());
    let is_image = resolved_mime.starts_with("image/");
    let item_type = if is_image { ItemType::Image } else { ItemType::File };
    let resolved_name = filename.unwrap_or_else(|| {
        if is_image {
            "image.png".to_string()
        } else {
            "file".to_string()
        }
    });

    match st.store.create(CreateItemInput {
        id,
        item_type,
        content: None,
        filename: Some(resolved_name),
        mime_type: Some(resolved_mime),
        size: file_size,
        pinned,
        label,
        device_name,
        created_at: None,
        updated_at: None,
    }) {
        Ok(created) => {
            for trimmed_id in created.trimmed_ids {
                st.hub.notify_item_deleted(trimmed_id);
            }
            st.hub.notify_item_created(created.item.clone());
            (StatusCode::CREATED, Json(created.item)).into_response()
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&blob_path).await;
            json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadBase64Body {
    data: Option<String>,
    mime_type: Option<String>,
    filename: Option<String>,
    pinned: Option<bool>,
    label: Option<String>,
    device_name: Option<String>,
}

async fn upload_base64(State(st): State<AppState>, Json(body): Json<UploadBase64Body>) -> Response {
    let Some(data) = body.data else {
        return json_error(StatusCode::BAD_REQUEST, "data base64 obrigatório");
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(data.trim()) {
        Ok(b) if !b.is_empty() => b,
        Ok(_) => return json_error(StatusCode::BAD_REQUEST, "Dados vazios"),
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "Base64 inválido"),
    };

    let resolved_mime = body
        .mime_type
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let is_image = resolved_mime.starts_with("image/");
    let item_type = if is_image { ItemType::Image } else { ItemType::File };
    let id = Uuid::new_v4().to_string();

    if let Err(e) = st.store.save_blob(&id, &bytes) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }

    let resolved_name = body.filename.filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if is_image {
            "clipboard.png".to_string()
        } else {
            "file".to_string()
        }
    });

    match st.store.create(CreateItemInput {
        id,
        item_type,
        content: None,
        filename: Some(resolved_name),
        mime_type: Some(resolved_mime),
        size: bytes.len() as i64,
        pinned: body.pinned.unwrap_or(false),
        label: body.label.filter(|s| !s.is_empty()),
        device_name: body.device_name.filter(|s| !s.is_empty()),
        created_at: None,
        updated_at: None,
    }) {
        Ok(created) => {
            for trimmed_id in created.trimmed_ids {
                st.hub.notify_item_deleted(trimmed_id);
            }
            st.hub.notify_item_created(created.item.clone());
            (StatusCode::CREATED, Json(created.item)).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn touch_item(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.store.touch(&id) {
        Ok(Some(item)) => {
            st.hub.notify_item_updated(item.clone());
            Json(item).into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Item não encontrado"),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn patch_item(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let has_label = body.get("label").is_some();
    let has_pinned = body.get("pinned").is_some();
    let has_content = body.get("content").is_some();
    let bump = body.get("bump").and_then(|v| v.as_bool()) == Some(true);

    if bump && !has_label && !has_pinned && !has_content {
        return touch_item(State(st), Path(id)).await;
    }

    let fields = UpdateItemFields {
        label: if has_label {
            Some(body.get("label").and_then(|v| v.as_str()).map(|s| s.to_string()))
        } else {
            None
        },
        pinned: body.get("pinned").and_then(|v| v.as_bool()),
        content: if has_content {
            Some(body.get("content").and_then(|v| v.as_str()).map(|s| s.to_string()))
        } else {
            None
        },
    };

    match st.store.update(&id, fields) {
        Ok(Some(item)) => {
            let final_item: ClipItem = if bump {
                st.store.touch(&item.id).ok().flatten().unwrap_or(item)
            } else {
                item
            };
            st.hub.notify_item_updated(final_item.clone());
            Json(final_item).into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Item não encontrado"),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn delete_item(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    match st.store.delete(&id) {
        Ok(Some(item)) => {
            st.hub.notify_item_deleted(item.id);
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "Item não encontrado"),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(st): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_ws(socket, st))
}

async fn handle_ws(socket: WebSocket, st: AppState) {
    let client_id = st.hub.next_client_id();
    let mut rx = st.hub.subscribe();
    let (mut sender, mut receiver) = socket.split();

    // Envia sync_request inicial
    let history = st.store.list(false, 100).unwrap_or_default();
    let pinned = st.store.list(true, 500).unwrap_or_default();
    let init = WsMessage::SyncRequest {
        items: SyncSnapshot { history, pinned },
    };
    if let Ok(text) = serde_json::to_string(&init) {
        if sender.send(Message::Text(text.into())).await.is_err() {
            return;
        }
    }

    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(raw) = msg {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if val.get("type").and_then(|v| v.as_str()) == Some("hello") {
                    if let Some(name) = val.get("deviceName").and_then(|v| v.as_str()) {
                        st.hub.set_device_name(client_id, name.to_string());
                    }
                }
            }
        }
    }

    send_task.abort();
    st.hub.remove_client(client_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tempfile::tempdir;
    use tower::ServiceExt;

    #[tokio::test]
    async fn api_text_pin_and_list() {
        let dir = tempdir().unwrap();
        let store = Arc::new(ClipStore::open(dir.path()).unwrap());
        let hub = Arc::new(Hub::new());
        let updater = Arc::new(UpdateChecker::new("2.0.0"));
        let app = create_router(
            AppState {
                store,
                hub,
                pair: None,
                updater,
            },
            ServerPaths {
                client_dist: None,
                release_dir: None,
            },
        );

        // POST /api/items/text
        let req = Request::builder()
            .method("POST")
            .uri("/api/items/text")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"content":"hello rust","pinned":true,"label":"Teste","deviceName":"Mac"}"#,
            ))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);

        // GET /api/items?pinned=true
        let req2 = Request::builder()
            .method("GET")
            .uri("/api/items?pinned=true")
            .body(Body::empty())
            .unwrap();
        let resp2 = app.oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp2.into_body(), 1024 * 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["total"], 1);
        assert_eq!(json["items"][0]["label"], "Teste");
    }
}
