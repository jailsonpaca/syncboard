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
