package com.syncboard.android.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class ClipItem(
    val id: String,
    val type: String,
    val content: String? = null,
    val filename: String? = null,
    @SerialName("mimeType") val mimeType: String? = null,
    val size: Long = 0,
    val pinned: Boolean = false,
    val label: String? = null,
    @SerialName("deviceName") val deviceName: String? = null,
    @SerialName("createdAt") val createdAt: Long = 0,
    @SerialName("updatedAt") val updatedAt: Long = 0,
)

@Serializable
data class ItemsPage(
    val items: List<ClipItem> = emptyList(),
    val total: Int = 0,
    val limit: Int = 20,
    val offset: Int = 0,
)

@Serializable
data class DeviceInfo(
    val name: String,
    val online: Boolean = false,
)

/** Deduplica nomes iguais e variantes com sufixo aleatório (ex.: Pixel-a1b2). */
fun dedupeDevices(devices: List<DeviceInfo>): List<DeviceInfo> {
    fun baseKey(name: String): String {
        val trimmed = name.trim()
        val m = Regex("""^(.*)-([a-z0-9]{4})$""", RegexOption.IGNORE_CASE).matchEntire(trimmed)
        return if (m != null) m.groupValues[1].lowercase() else trimmed.lowercase()
    }

    val byExact = linkedMapOf<String, DeviceInfo>()
    for (d in devices) {
        val name = d.name.trim()
        if (name.isEmpty()) continue
        val key = name.lowercase()
        val prev = byExact[key]
        if (prev == null || (d.online && !prev.online)) {
            byExact[key] = DeviceInfo(name, d.online)
        } else if (d.online) {
            byExact[key] = prev.copy(online = true)
        }
    }

    val groups = linkedMapOf<String, MutableList<DeviceInfo>>()
    for (d in byExact.values) {
        groups.getOrPut(baseKey(d.name)) { mutableListOf() }.add(d)
    }

    val result = mutableListOf<DeviceInfo>()
    for (group in groups.values) {
        if (group.size == 1) {
            result.add(group[0])
            continue
        }
        val online = group.filter { it.online }
        if (online.isNotEmpty()) {
            result.addAll(online)
        } else {
            result.add(group.minWith(compareBy({ it.name.length }, { it.name })))
        }
    }
    return result.sortedBy { it.name.lowercase() }
}

@Serializable
data class DevicesResponse(
    val devices: List<DeviceInfo> = emptyList(),
)

@Serializable
data class PairInfo(
    val code: String,
    val url: String,
    val urls: List<String> = emptyList(),
    val token: String = "",
    val qrPayload: String = "",
    val joinUrl: String = "",
)

@Serializable
data class JoinResult(
    val serverUrl: String,
    val token: String? = null,
    val urls: List<String> = emptyList(),
)

@Serializable
data class HealthResponse(
    val ok: Boolean = false,
    val service: String? = null,
    val version: String? = null,
)

@Serializable
data class WsMessage(
    val type: String,
    val item: ClipItem? = null,
    val id: String? = null,
    val items: WsItems? = null,
)

@Serializable
data class WsItems(
    val history: List<ClipItem> = emptyList(),
    val pinned: List<ClipItem> = emptyList(),
)

enum class ScreenshotSyncMode {
    OFF, ASK, AUTO;

    companion object {
        fun from(raw: String?) = entries.find { it.name.equals(raw, true) } ?: ASK
    }
}
