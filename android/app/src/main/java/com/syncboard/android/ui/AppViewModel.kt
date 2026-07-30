package com.syncboard.android.ui

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.syncboard.android.SyncBoardApp
import com.syncboard.android.data.ClipItem
import com.syncboard.android.data.DeviceInfo
import com.syncboard.android.data.ScreenshotSyncMode
import com.syncboard.android.data.dedupeDevices
import com.syncboard.android.pair.UdpDiscovery
import com.syncboard.android.sync.PendingScreenshot
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

data class UiState(
    val serverUrl: String? = null,
    val connected: Boolean = false,
    val history: List<ClipItem> = emptyList(),
    val pinned: List<ClipItem> = emptyList(),
    val loading: Boolean = false,
    val pairing: Boolean = false,
    val pairError: String? = null,
    val deviceName: String = "",
    val devices: List<DeviceInfo> = emptyList(),
    val deviceFilter: String = "",
    val clipboardSync: Boolean = true,
    val screenshotMode: ScreenshotSyncMode = ScreenshotSyncMode.ASK,
    val pendingScreenshot: PendingScreenshot? = null,
    val toast: String? = null,
)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val sb = SyncBoardApp.instance
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            combine(sb.prefs.serverUrl, sb.prefs.deviceName, sb.prefs.clipboardSync, sb.prefs.screenshotMode) {
                    url, name, clip, shot ->
                Quad(url, name, clip, shot)
            }.collect { q ->
                _state.value = _state.value.copy(
                    serverUrl = q.a,
                    deviceName = q.b,
                    clipboardSync = q.c,
                    screenshotMode = q.d,
                )
                if (!q.a.isNullOrBlank()) {
                    sb.ws.connect(q.a)
                    reload()
                    if (q.d != ScreenshotSyncMode.OFF) sb.mediaWatcher.start()
                } else {
                    sb.ws.disconnect()
                    sb.mediaWatcher.stop()
                }
            }
        }
        viewModelScope.launch {
            sb.ws.connected.collect { ok ->
                _state.value = _state.value.copy(connected = ok)
            }
        }
        viewModelScope.launch {
            sb.ws.messages.collect { msg ->
                when (msg.type) {
                    "sync_request" -> {
                        val h = msg.items?.history.orEmpty()
                        val p = msg.items?.pinned.orEmpty()
                        _state.value = _state.value.copy(history = h, pinned = p, loading = false)
                    }
                    "item_created", "item_updated" -> msg.item?.let { upsert(it) }
                    "item_deleted" -> msg.id?.let { remove(it) }
                }
            }
        }
        viewModelScope.launch {
            sb.mediaWatcher.pendingAsk.collect { pending ->
                _state.value = _state.value.copy(pendingScreenshot = pending)
            }
        }
    }

    fun clearToast() {
        _state.value = _state.value.copy(toast = null)
    }

    fun connectToServer(serverUrl: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(pairing = true, pairError = null)
            try {
                val url = serverUrl.trim().trimEnd('/')
                sb.api.health(url)
                sb.prefs.setServerUrl(url)
                _state.value = _state.value.copy(pairing = false, toast = "Conectado a $url")
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    pairing = false,
                    pairError = e.message ?: "Falha ao conectar",
                )
            }
        }
    }

    fun pairWithInput(raw: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(pairing = true, pairError = null)
            try {
                val (urlFromPayload, codeFromPayload) = UdpDiscovery.parseJoinPayload(raw)
                var serverUrl = urlFromPayload
                val code = codeFromPayload ?: raw.trim().uppercase()

                if (serverUrl == null) {
                    val found = UdpDiscovery.discoverByCode(code)
                    serverUrl = found.serverUrl
                } else if (!code.isNullOrBlank()) {
                    runCatching { sb.api.joinPair(serverUrl!!, code) }
                }

                sb.api.health(serverUrl)
                sb.prefs.setServerUrl(serverUrl)
                _state.value = _state.value.copy(pairing = false, toast = "Conectado a $serverUrl")
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    pairing = false,
                    pairError = e.message ?: "Falha ao parear",
                )
            }
        }
    }

    fun unpair() {
        viewModelScope.launch {
            sb.prefs.clearPairing()
            sb.ws.disconnect()
            sb.mediaWatcher.stop()
            _state.value = _state.value.copy(
                serverUrl = null,
                history = emptyList(),
                pinned = emptyList(),
                connected = false,
            )
        }
    }

    fun setDeviceFilter(device: String) {
        _state.value = _state.value.copy(deviceFilter = device)
        reload()
    }

    fun reload() {
        viewModelScope.launch {
            val url = sb.prefs.getServerUrl() ?: return@launch
            val device = _state.value.deviceFilter.ifBlank { null }
            _state.value = _state.value.copy(loading = true)
            try {
                val h = sb.api.fetchItems(false, device = device)
                val p = sb.api.fetchItems(true, device = device)
                val devices = runCatching { sb.api.fetchDevices() }.getOrDefault(emptyList())
                val fallback = (h.items + p.items).mapNotNull { it.deviceName }.distinct()
                    .map { DeviceInfo(it, online = false) }
                _state.value = _state.value.copy(
                    history = h.items,
                    pinned = p.items,
                    devices = dedupeDevices(devices.ifEmpty { fallback }),
                    loading = false,
                    serverUrl = url,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(loading = false, toast = e.message)
            }
        }
    }

    fun onResumeSync() {
        viewModelScope.launch {
            try {
                val msg = sb.clipboardMonitor.syncIfNeeded()
                if (msg != null) {
                    _state.value = _state.value.copy(toast = msg)
                    reload()
                }
            } catch (_: Exception) {
            }
        }
    }

    fun copyItem(item: ClipItem) {
        viewModelScope.launch {
            try {
                val cm = getApplication<Application>().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                when (item.type) {
                    "text" -> {
                        cm.setPrimaryClip(ClipData.newPlainText("syncboard", item.content ?: ""))
                        if (!item.pinned) runCatching { sb.api.touch(item.id) }
                        _state.value = _state.value.copy(toast = "Copiado")
                    }
                    else -> {
                        val bytes = sb.api.downloadBlob(item.id)
                        // Salva temp e copia URI via ClipData.newUri precisa FileProvider —
                        // MVP: copia texto do filename + salva em cache e notifica
                        val cache = getApplication<Application>().cacheDir.resolve(item.filename ?: "file.bin")
                        cache.writeBytes(bytes)
                        if (item.type == "image" || item.mimeType?.startsWith("image/") == true) {
                            // fallback texto path — melhor UX: toast + arquivo no cache
                            cm.setPrimaryClip(ClipData.newPlainText("syncboard", cache.absolutePath))
                        } else {
                            cm.setPrimaryClip(ClipData.newPlainText("syncboard", item.filename ?: cache.name))
                        }
                        if (!item.pinned) runCatching { sb.api.touch(item.id) }
                        _state.value = _state.value.copy(toast = "Salvo: ${cache.name}")
                    }
                }
                reload()
            } catch (e: Exception) {
                _state.value = _state.value.copy(toast = e.message)
            }
        }
    }

    fun pinItem(item: ClipItem) {
        viewModelScope.launch {
            try {
                sb.api.updateItem(item.id, pinned = true)
                reload()
            } catch (e: Exception) {
                _state.value = _state.value.copy(toast = e.message)
            }
        }
    }

    fun unpinItem(item: ClipItem) {
        viewModelScope.launch {
            try {
                sb.api.updateItem(item.id, pinned = false)
                reload()
            } catch (e: Exception) {
                _state.value = _state.value.copy(toast = e.message)
            }
        }
    }

    fun deleteItem(item: ClipItem) {
        viewModelScope.launch {
            try {
                sb.api.deleteItem(item.id)
                remove(item.id)
            } catch (e: Exception) {
                _state.value = _state.value.copy(toast = e.message)
            }
        }
    }

    fun setDeviceName(name: String) = viewModelScope.launch { sb.prefs.setDeviceName(name) }
    fun setClipboardSync(v: Boolean) = viewModelScope.launch { sb.prefs.setClipboardSync(v) }
    fun setScreenshotMode(mode: ScreenshotSyncMode) = viewModelScope.launch {
        sb.prefs.setScreenshotMode(mode)
        if (mode == ScreenshotSyncMode.OFF) sb.mediaWatcher.stop()
        else if (!sb.prefs.getServerUrl().isNullOrBlank()) sb.mediaWatcher.start()
    }

    fun acceptScreenshot() {
        val pending = _state.value.pendingScreenshot ?: return
        viewModelScope.launch {
            try {
                sb.mediaWatcher.accept(pending)
                _state.value = _state.value.copy(pendingScreenshot = null, toast = "Screenshot enviado")
                reload()
            } catch (e: Exception) {
                _state.value = _state.value.copy(toast = e.message)
            }
        }
    }

    fun dismissScreenshot() {
        val pending = _state.value.pendingScreenshot ?: return
        viewModelScope.launch {
            sb.mediaWatcher.dismiss(pending)
            _state.value = _state.value.copy(pendingScreenshot = null)
        }
    }

    private fun upsert(item: ClipItem) {
        val s = _state.value
        _state.value = if (item.pinned) {
            s.copy(
                pinned = listOf(item) + s.pinned.filter { it.id != item.id },
                history = s.history.filter { it.id != item.id },
            )
        } else {
            s.copy(
                history = listOf(item) + s.history.filter { it.id != item.id },
                pinned = s.pinned.filter { it.id != item.id },
            )
        }
    }

    private fun remove(id: String) {
        val s = _state.value
        _state.value = s.copy(
            history = s.history.filter { it.id != id },
            pinned = s.pinned.filter { it.id != id },
        )
    }

    private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)
}

fun toast(context: Context, msg: String) {
    Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
}
