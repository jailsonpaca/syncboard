package com.syncboard.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class ShareActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = SyncBoardApp.instance
        lifecycleScope.launch {
            val server = app.prefs.getServerUrl()
            if (server.isNullOrBlank()) {
                Toast.makeText(this@ShareActivity, "Pareie o SyncBoard antes de compartilhar", Toast.LENGTH_LONG).show()
                startActivity(Intent(this@ShareActivity, MainActivity::class.java))
                finish()
                return@launch
            }

            try {
                when (intent?.action) {
                    Intent.ACTION_SEND -> handleSingle(intent)
                    Intent.ACTION_SEND_MULTIPLE -> handleMultiple(intent)
                    else -> Unit
                }
                Toast.makeText(this@ShareActivity, "Enviado ao SyncBoard", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@ShareActivity, e.message ?: "Falha ao enviar", Toast.LENGTH_LONG).show()
            } finally {
                finish()
            }
        }
    }

    private suspend fun handleSingle(intent: Intent) {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val stream = intent.getParcelableExtraCompat<Uri>(Intent.EXTRA_STREAM)
        val app = SyncBoardApp.instance
        val device = app.prefs.getDeviceName()
        when {
            stream != null -> uploadUri(stream, intent.type)
            !text.isNullOrBlank() -> app.api.createText(text, device)
            else -> error("Nada para compartilhar")
        }
    }

    private suspend fun handleMultiple(intent: Intent) {
        val uris = intent.getParcelableArrayListExtraCompat<Uri>(Intent.EXTRA_STREAM).orEmpty()
        if (uris.isEmpty()) error("Nada para compartilhar")
        for (uri in uris) uploadUri(uri, intent.type)
    }

    private suspend fun uploadUri(uri: Uri, fallbackMime: String?) {
        val app = SyncBoardApp.instance
        val cr = contentResolver
        val mime = cr.getType(uri) ?: fallbackMime ?: "application/octet-stream"
        val name = queryDisplayName(uri) ?: "share.bin"
        val bytes = cr.openInputStream(uri)?.use { it.readBytes() }
            ?: error("Não foi possível ler o arquivo")
        if (mime.startsWith("text/") && bytes.size < 1_000_000) {
            app.api.createText(bytes.toString(Charsets.UTF_8), app.prefs.getDeviceName())
        } else {
            app.api.uploadBytes(bytes, name, mime, app.prefs.getDeviceName())
        }
    }

    private fun queryDisplayName(uri: Uri): String? {
        contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c ->
                if (c.moveToFirst()) return c.getString(0)
            }
        return uri.lastPathSegment
    }
}

@Suppress("DEPRECATION")
private inline fun <reified T> Intent.getParcelableExtraCompat(key: String): T? {
    return if (android.os.Build.VERSION.SDK_INT >= 33) {
        getParcelableExtra(key, T::class.java)
    } else {
        getParcelableExtra(key) as? T
    }
}

@Suppress("DEPRECATION")
private inline fun <reified T : android.os.Parcelable> Intent.getParcelableArrayListExtraCompat(key: String): ArrayList<T>? {
    return if (android.os.Build.VERSION.SDK_INT >= 33) {
        getParcelableArrayListExtra(key, T::class.java)
    } else {
        getParcelableArrayListExtra(key)
    }
}
