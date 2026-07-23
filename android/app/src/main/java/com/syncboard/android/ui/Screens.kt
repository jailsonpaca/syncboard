package com.syncboard.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.syncboard.android.data.ClipItem
import com.syncboard.android.data.ScreenshotSyncMode

@Composable
fun SyncBoardRoot(
    vm: AppViewModel,
    onScanQr: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val snack = remember { SnackbarHostState() }

    LaunchedEffect(state.toast) {
        val msg = state.toast ?: return@LaunchedEffect
        snack.showSnackbar(msg)
        vm.clearToast()
    }

    if (state.serverUrl.isNullOrBlank()) {
        PairScreen(
            pairing = state.pairing,
            error = state.pairError,
            onPair = vm::pairWithInput,
            onScanQr = onScanQr,
            snack = snack,
        )
    } else {
        HomeScreen(vm = vm, state = state, snack = snack)
    }

    state.pendingScreenshot?.let { pending ->
        AlertDialog(
            onDismissRequest = vm::dismissScreenshot,
            title = { Text("Novo screenshot") },
            text = { Text("Enviar \"${pending.displayName}\" ao SyncBoard?") },
            confirmButton = {
                TextButton(onClick = vm::acceptScreenshot) { Text("Enviar") }
            },
            dismissButton = {
                TextButton(onClick = vm::dismissScreenshot) { Text("Ignorar") }
            },
        )
    }
}

@Composable
private fun PairScreen(
    pairing: Boolean,
    error: String?,
    onPair: (String) -> Unit,
    onScanQr: () -> Unit,
    snack: SnackbarHostState,
) {
    var code by remember { mutableStateOf("") }
    Scaffold(snackbarHost = { SnackbarHost(snack) }) { pad ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(pad)
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "SyncBoard",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "Digite o código do servidor na mesma Wi‑Fi",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(24.dp))
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.uppercase().take(8) },
                label = { Text("Código") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = { onPair(code) },
                enabled = !pairing && code.length >= 4,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (pairing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text("Parear")
            }
            TextButton(onClick = onScanQr) {
                Icon(Icons.Default.QrCodeScanner, contentDescription = null)
                Spacer(Modifier.size(8.dp))
                Text("Escanear QR")
            }
            if (!error.isNullOrBlank()) {
                Spacer(Modifier.height(12.dp))
                Text(error, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(vm: AppViewModel, state: UiState, snack: SnackbarHostState) {
    var tab by remember { mutableIntStateOf(0) }
    var showSettings by remember { mutableStateOf(false) }

    Scaffold(
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("SyncBoard", fontWeight = FontWeight.Bold)
                        Text(
                            if (state.connected) "● online" else "○ offline",
                            style = MaterialTheme.typography.labelSmall,
                            color = if (state.connected) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = vm::reload) {
                        Icon(Icons.Default.Refresh, contentDescription = "Atualizar")
                    }
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Default.Settings, contentDescription = "Configurações")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                ),
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad)) {
            TabRow(selectedTabIndex = tab) {
                Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("Histórico") })
                Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("Fixo") })
            }
            val items = if (tab == 0) state.history else state.pinned
            if (state.loading && items.isEmpty()) {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) { CircularProgressIndicator() }
            } else if (items.isEmpty()) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        if (tab == 0) "Nada no histórico ainda." else "Nenhum item fixo.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(items, key = { it.id }) { item ->
                        ItemCard(
                            item = item,
                            serverUrl = state.serverUrl.orEmpty(),
                            isPinnedTab = tab == 1,
                            onCopy = { vm.copyItem(item) },
                            onPin = { vm.pinItem(item) },
                            onUnpin = { vm.unpinItem(item) },
                            onDelete = { vm.deleteItem(item) },
                        )
                    }
                }
            }
        }
    }

    if (showSettings) {
        SettingsDialog(
            state = state,
            onDismiss = { showSettings = false },
            onDeviceName = vm::setDeviceName,
            onClipboard = vm::setClipboardSync,
            onScreenshot = vm::setScreenshotMode,
            onUnpair = {
                showSettings = false
                vm.unpair()
            },
        )
    }
}

@Composable
private fun ItemCard(
    item: ClipItem,
    serverUrl: String,
    isPinnedTab: Boolean,
    onCopy: () -> Unit,
    onPin: () -> Unit,
    onUnpin: () -> Unit,
    onDelete: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onCopy),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    item.label ?: item.type.uppercase(),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    item.deviceName.orEmpty(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(8.dp))
            when (item.type) {
                "text" -> Text(
                    item.content.orEmpty(),
                    maxLines = 4,
                    overflow = TextOverflow.Ellipsis,
                )
                "image" -> AsyncImage(
                    model = "$serverUrl/api/items/${item.id}/blob",
                    contentDescription = item.filename,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(160.dp),
                    contentScale = ContentScale.Crop,
                )
                else -> Text(item.filename ?: "Arquivo", fontWeight = FontWeight.Medium)
            }
            Spacer(Modifier.height(8.dp))
            Row {
                IconButton(onClick = onCopy) {
                    Icon(Icons.Default.ContentCopy, contentDescription = "Copiar")
                }
                if (isPinnedTab) {
                    IconButton(onClick = onUnpin) {
                        Icon(Icons.Default.PushPin, contentDescription = "Desfixar")
                    }
                } else {
                    IconButton(onClick = onPin) {
                        Icon(Icons.Default.PushPin, contentDescription = "Fixar")
                    }
                }
                IconButton(onClick = onDelete) {
                    Icon(Icons.Default.Delete, contentDescription = "Excluir")
                }
            }
        }
    }
}

@Composable
private fun SettingsDialog(
    state: UiState,
    onDismiss: () -> Unit,
    onDeviceName: (String) -> Unit,
    onClipboard: (Boolean) -> Unit,
    onScreenshot: (ScreenshotSyncMode) -> Unit,
    onUnpair: () -> Unit,
) {
    var name by remember(state.deviceName) { mutableStateOf(state.deviceName) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Configurações") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(state.serverUrl.orEmpty(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Nome do dispositivo") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Sync clipboard", modifier = Modifier.weight(1f))
                    Switch(checked = state.clipboardSync, onCheckedChange = onClipboard)
                }
                Text("Screenshots", style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ScreenshotSyncMode.entries.forEach { mode ->
                        FilterChip(
                            selected = state.screenshotMode == mode,
                            onClick = { onScreenshot(mode) },
                            label = { Text(mode.name) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onDeviceName(name)
                onDismiss()
            }) { Text("Salvar") }
        },
        dismissButton = {
            TextButton(onClick = onUnpair) {
                Icon(Icons.Default.LinkOff, contentDescription = null)
                Spacer(Modifier.size(6.dp))
                Text("Desparear")
            }
        },
    )
}
