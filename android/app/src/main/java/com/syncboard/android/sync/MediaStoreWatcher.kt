package com.syncboard.android.sync

import android.content.ContentUris
import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import com.syncboard.android.data.ApiClient
import com.syncboard.android.data.ScreenshotSyncMode
import com.syncboard.android.prefs.AppPrefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class PendingScreenshot(
    val mediaId: String,
    val uri: Uri,
    val displayName: String,
    val mimeType: String,
    val size: Long,
)

class MediaStoreWatcher(
    private val context: Context,
    private val prefs: AppPrefs,
    private val api: ApiClient,
    private val scope: CoroutineScope,
) {
    private val _pendingAsk = MutableSharedFlow<PendingScreenshot>(extraBufferCapacity = 8)
    val pendingAsk: SharedFlow<PendingScreenshot> = _pendingAsk

    private var observer: ContentObserver? = null
    private var started = false

    fun start() {
        if (started) return
        started = true
        val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                scope.launch { scanRecent() }
            }
        }
        observer = obs
        context.contentResolver.registerContentObserver(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            true,
            obs
        )
        scope.launch { scanRecent() }
    }

    fun stop() {
        observer?.let { context.contentResolver.unregisterContentObserver(it) }
        observer = null
        started = false
    }

    suspend fun scanRecent() {
        val mode = prefs.getScreenshotMode()
        if (mode == ScreenshotSyncMode.OFF) return
        if (prefs.getServerUrl().isNullOrBlank()) return

        val recent = queryRecentScreenshots()
        val seen = prefs.getSeenMediaIds()
        for (item in recent) {
            if (seen.contains(item.mediaId)) continue
            when (mode) {
                ScreenshotSyncMode.AUTO -> {
                    upload(item)
                    prefs.addSeenMediaId(item.mediaId)
                }
                ScreenshotSyncMode.ASK -> {
                    _pendingAsk.emit(item)
                }
                ScreenshotSyncMode.OFF -> Unit
            }
        }
    }

    suspend fun accept(item: PendingScreenshot) {
        upload(item)
        prefs.addSeenMediaId(item.mediaId)
    }

    suspend fun dismiss(item: PendingScreenshot) {
        prefs.addSeenMediaId(item.mediaId)
    }

    private suspend fun upload(item: PendingScreenshot) = withContext(Dispatchers.IO) {
        val bytes = context.contentResolver.openInputStream(item.uri)?.use { it.readBytes() }
            ?: return@withContext
        api.uploadBytes(
            bytes = bytes,
            filename = item.displayName.ifBlank { "screenshot.jpg" },
            mimeType = item.mimeType.ifBlank { "image/jpeg" },
            deviceName = prefs.getDeviceName(),
        )
    }

    private suspend fun queryRecentScreenshots(): List<PendingScreenshot> = withContext(Dispatchers.IO) {
        val out = mutableListOf<PendingScreenshot>()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.RELATIVE_PATH,
        )
        val since = (System.currentTimeMillis() / 1000L) - 120 // últimos 2 min
        val selection = "${MediaStore.Images.Media.DATE_ADDED} >= ?"
        context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            arrayOf(since.toString()),
            "${MediaStore.Images.Media.DATE_ADDED} DESC"
        )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val mimeCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val pathCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
            while (cursor.moveToNext()) {
                val path = cursor.getString(pathCol) ?: ""
                val name = cursor.getString(nameCol) ?: ""
                val isShot = path.contains("Screenshot", true) ||
                    path.contains("Screenshots", true) ||
                    name.contains("Screenshot", true) ||
                    name.startsWith("IMG_", true) && path.contains("Pictures", true)
                // aceita screenshots; também imagens muito recentes na pasta Screenshots
                if (!isShot && !path.contains("Screenshots", true)) continue
                val id = cursor.getLong(idCol)
                val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                out += PendingScreenshot(
                    mediaId = id.toString(),
                    uri = uri,
                    displayName = name,
                    mimeType = cursor.getString(mimeCol) ?: "image/jpeg",
                    size = cursor.getLong(sizeCol),
                )
            }
        }
        out
    }
}
