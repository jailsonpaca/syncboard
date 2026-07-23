package com.syncboard.android.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Teal = Color(0xFF3ECFBE)
private val Blue = Color(0xFF5B7CFA)
private val Bg = Color(0xFF0C0D12)
private val Surface = Color(0xFF151822)
private val Text = Color(0xFFEEF0F7)
private val Muted = Color(0xFF8B92A8)
private val Danger = Color(0xFFFF6B6B)

private val scheme = darkColorScheme(
    primary = Teal,
    secondary = Blue,
    background = Bg,
    surface = Surface,
    onPrimary = Color(0xFF041512),
    onSecondary = Text,
    onBackground = Text,
    onSurface = Text,
    onSurfaceVariant = Muted,
    error = Danger,
)

@Composable
fun SyncBoardTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
