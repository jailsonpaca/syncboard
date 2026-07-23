package com.syncboard.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.syncboard.android.data.ScreenshotSyncMode
import com.syncboard.android.ui.AppViewModel
import com.syncboard.android.ui.SyncBoardRoot
import com.syncboard.android.ui.theme.SyncBoardTheme
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels()

    private val qrLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val payload = result.data?.getStringExtra(QrScanActivity.EXTRA_RESULT) ?: return@registerForActivityResult
        vm.pairWithInput(payload)
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { /* ok */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleJoinIntent(intent)
        maybeRequestMediaPermission()

        setContent {
            SyncBoardTheme {
                SyncBoardRoot(
                    vm = vm,
                    onScanQr = {
                        qrLauncher.launch(Intent(this, QrScanActivity::class.java))
                    },
                )
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                // keep collector alive while started — clipboard on resume below
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleJoinIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        vm.onResumeSync()
    }

    private fun handleJoinIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        if (data.startsWith("syncboard://")) {
            vm.pairWithInput(data)
        }
    }

    private fun maybeRequestMediaPermission() {
        lifecycleScope.launch {
            val prefs = SyncBoardApp.instance.prefs
            if (prefs.getScreenshotMode() == ScreenshotSyncMode.OFF) return@launch
            val needed = buildList {
                if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.READ_MEDIA_IMAGES)
                else add(Manifest.permission.READ_EXTERNAL_STORAGE)
            }.filter {
                ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED
            }
            if (needed.isNotEmpty()) permissionLauncher.launch(needed.toTypedArray())
        }
    }
}
