package com.syncboard.android

import android.app.Application
import com.syncboard.android.data.ApiClient
import com.syncboard.android.data.WsClient
import com.syncboard.android.prefs.AppPrefs
import com.syncboard.android.sync.ClipboardMonitor
import com.syncboard.android.sync.MediaStoreWatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json

class SyncBoardApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var prefs: AppPrefs
        private set
    lateinit var api: ApiClient
        private set
    lateinit var ws: WsClient
        private set
    lateinit var clipboardMonitor: ClipboardMonitor
        private set
    lateinit var mediaWatcher: MediaStoreWatcher
        private set

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = AppPrefs(this)
        api = ApiClient { prefs.getServerUrl() }
        ws = WsClient(appScope, api.okHttp(), json) { prefs.getDeviceName() }
        clipboardMonitor = ClipboardMonitor(this, prefs, api)
        mediaWatcher = MediaStoreWatcher(this, prefs, api, appScope)
    }

    companion object {
        lateinit var instance: SyncBoardApp
            private set
    }
}
