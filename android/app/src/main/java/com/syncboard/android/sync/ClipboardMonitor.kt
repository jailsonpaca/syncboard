package com.syncboard.android.sync

import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import com.syncboard.android.data.ApiClient
import com.syncboard.android.prefs.AppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.MessageDigest

class ClipboardMonitor(
    private val context: Context,
    private val prefs: AppPrefs,
    private val api: ApiClient,
) {
    private var lastHash: String? = null

    suspend fun syncIfNeeded(): String? {
        if (!prefs.isClipboardSync()) return null
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        if (!cm.hasPrimaryClip()) return null
        val clip = cm.primaryClip ?: return null
        val desc = clip.description ?: return null

        return when {
            desc.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) ||
                desc.hasMimeType(ClipDescription.MIMETYPE_TEXT_HTML) -> {
                val text = clip.getItemAt(0)?.coerceToText(context)?.toString()?.trim().orEmpty()
                if (text.isBlank()) return null
                val hash = sha("text:$text")
                if (hash == lastHash) return null
                lastHash = hash
                api.createText(text, prefs.getDeviceName())
                "Texto sincronizado"
            }

            desc.hasMimeType("image/*") -> {
                val item = clip.getItemAt(0) ?: return null
                val uri = item.uri ?: return null
                val bytes = readUri(uri) ?: return null
                val hash = sha("img:${bytes.size}:${bytes.take(64).joinToString()}")
                if (hash == lastHash) return null
                lastHash = hash
                val mime = context.contentResolver.getType(uri) ?: "image/png"
                val name = "clipboard.${extFor(mime)}"
                api.uploadBytes(bytes, name, mime, prefs.getDeviceName())
                "Imagem sincronizada"
            }

            else -> null
        }
    }

    private suspend fun readUri(uri: Uri): ByteArray? = withContext(Dispatchers.IO) {
        try {
            context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (_: Exception) {
            null
        }
    }

    private fun sha(s: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
        return d.joinToString("") { "%02x".format(it) }
    }

    private fun extFor(mime: String) = when {
        mime.contains("jpeg") || mime.contains("jpg") -> "jpg"
        mime.contains("webp") -> "webp"
        mime.contains("gif") -> "gif"
        else -> "png"
    }
}
