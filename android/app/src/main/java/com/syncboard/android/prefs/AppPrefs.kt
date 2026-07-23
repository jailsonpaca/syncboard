package com.syncboard.android.prefs

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.syncboard.android.data.ScreenshotSyncMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.util.UUID

private val Context.dataStore by preferencesDataStore("syncboard_prefs")

class AppPrefs(private val context: Context) {
    private val serverUrlKey = stringPreferencesKey("server_url")
    private val deviceNameKey = stringPreferencesKey("device_name")
    private val clipboardSyncKey = booleanPreferencesKey("clipboard_sync")
    private val screenshotModeKey = stringPreferencesKey("screenshot_mode")
    private val seenMediaIdsKey = stringSetPreferencesKey("seen_media_ids")
    private val pendingShareJsonKey = stringPreferencesKey("pending_share")

    val serverUrl: Flow<String?> = context.dataStore.data.map { it[serverUrlKey] }
    val deviceName: Flow<String> = context.dataStore.data.map {
        it[deviceNameKey] ?: defaultDeviceName()
    }
    val clipboardSync: Flow<Boolean> = context.dataStore.data.map { it[clipboardSyncKey] ?: true }
    val screenshotMode: Flow<ScreenshotSyncMode> = context.dataStore.data.map {
        ScreenshotSyncMode.from(it[screenshotModeKey])
    }

    suspend fun getServerUrl(): String? = serverUrl.first()
    suspend fun getDeviceName(): String = deviceName.first()
    suspend fun isClipboardSync(): Boolean = clipboardSync.first()
    suspend fun getScreenshotMode(): ScreenshotSyncMode = screenshotMode.first()

    suspend fun setServerUrl(url: String?) {
        context.dataStore.edit { prefs ->
            if (url.isNullOrBlank()) prefs.remove(serverUrlKey)
            else prefs[serverUrlKey] = url.trim().trimEnd('/')
        }
    }

    suspend fun setDeviceName(name: String) {
        context.dataStore.edit { it[deviceNameKey] = name.trim().ifBlank { defaultDeviceName() } }
    }

    suspend fun setClipboardSync(enabled: Boolean) {
        context.dataStore.edit { it[clipboardSyncKey] = enabled }
    }

    suspend fun setScreenshotMode(mode: ScreenshotSyncMode) {
        context.dataStore.edit { it[screenshotModeKey] = mode.name }
    }

    suspend fun getSeenMediaIds(): Set<String> {
        return context.dataStore.data.map { it[seenMediaIdsKey] ?: emptySet() }.first()
    }

    suspend fun addSeenMediaId(id: String) {
        context.dataStore.edit { prefs ->
            val next = (prefs[seenMediaIdsKey] ?: emptySet()).toMutableSet()
            next.add(id)
            // evita crescimento infinito
            prefs[seenMediaIdsKey] = next.toList().takeLast(200).toSet()
        }
    }

    suspend fun clearPairing() {
        context.dataStore.edit { it.remove(serverUrlKey) }
    }

    suspend fun setPendingShare(json: String?) {
        context.dataStore.edit { prefs ->
            if (json.isNullOrBlank()) prefs.remove(pendingShareJsonKey)
            else prefs[pendingShareJsonKey] = json
        }
    }

    suspend fun getPendingShare(): String? =
        context.dataStore.data.map { it[pendingShareJsonKey] }.first()

    private fun defaultDeviceName(): String {
        val model = android.os.Build.MODEL?.replace(" ", "-") ?: "Android"
        return "$model-${UUID.randomUUID().toString().take(4)}"
    }
}
