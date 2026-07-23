package com.syncboard.android.pair

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface

object UdpDiscovery {
    const val MULTICAST = "239.255.77.87"
    const val PORT = 18787

    data class Result(val serverUrl: String, val token: String? = null)

    suspend fun discoverByCode(code: String, timeoutMs: Long = 5000): Result = withContext(Dispatchers.IO) {
        val normalized = code.trim().uppercase().replace(Regex("[^A-Z0-9]"), "")
        require(normalized.length >= 4) { "Código inválido" }

        withTimeout(timeoutMs) {
            val group = InetAddress.getByName(MULTICAST)
            MulticastSocket(null).use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress(PORT))
                try {
                    val nif = NetworkInterface.getNetworkInterfaces()?.toList()
                        ?.firstOrNull { it.isUp && !it.isLoopback && it.supportsMulticast() }
                    if (nif != null) socket.joinGroup(InetSocketAddress(group, PORT), nif)
                    else socket.joinGroup(group)
                } catch (_: Exception) {
                    try {
                        socket.joinGroup(group)
                    } catch (_: Exception) {
                    }
                }

                val query = JSONObject()
                    .put("type", "syncboard-pair-query")
                    .put("code", normalized)
                    .toString()
                    .toByteArray(Charsets.UTF_8)
                val packet = DatagramPacket(query, query.size, group, PORT)
                socket.send(packet)
                try {
                    val broadcast = InetAddress.getByName("255.255.255.255")
                    socket.send(DatagramPacket(query, query.size, broadcast, PORT))
                } catch (_: Exception) {
                }

                val buf = ByteArray(4096)
                while (true) {
                    val incoming = DatagramPacket(buf, buf.size)
                    socket.receive(incoming)
                    val text = String(incoming.data, 0, incoming.length, Charsets.UTF_8)
                    try {
                        val obj = JSONObject(text)
                        if (obj.optString("type") != "syncboard-pair") continue
                        if (obj.optString("code").uppercase() != normalized) continue
                        val url = obj.optString("url").trimEnd('/')
                        if (url.isBlank()) continue
                        return@withTimeout Result(url, obj.optString("token").ifBlank { null })
                    } catch (_: Exception) {
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            error("unreachable")
        }
    }

    fun parseJoinPayload(raw: String): Pair<String?, String?> {
        val text = raw.trim()
        if (text.startsWith("syncboard://")) {
            val q = text.substringAfter('?', "")
            val params = q.split('&').associate {
                val (k, v) = it.split('=', limit = 2).let { p -> p[0] to p.getOrElse(1) { "" } }
                k to java.net.URLDecoder.decode(v, "UTF-8")
            }
            return params["url"]?.trimEnd('/') to params["code"]
        }
        if (text.startsWith("http://") || text.startsWith("https://")) {
            val uri = android.net.Uri.parse(text)
            val join = uri.getQueryParameter("join")
            return "${uri.scheme}://${uri.authority}" to join
        }
        if (text.matches(Regex("^[A-Za-z0-9]{4,8}$"))) {
            return null to text.uppercase()
        }
        return null to null
    }
}
