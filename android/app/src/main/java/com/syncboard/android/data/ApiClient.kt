package com.syncboard.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class ApiClient(
    private val baseUrlProvider: suspend () -> String?,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private suspend fun base(): String {
        val url = baseUrlProvider()?.trimEnd('/')
            ?: throw IllegalStateException("Servidor não configurado")
        return url
    }

    suspend fun health(url: String? = null): HealthResponse = withContext(Dispatchers.IO) {
        val root = (url ?: base()).trimEnd('/')
        val req = Request.Builder().url("$root/api/health").get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("Health ${res.code}")
            json.decodeFromString<HealthResponse>(res.body!!.string())
        }
    }

    suspend fun fetchItems(
        pinned: Boolean,
        limit: Int = 40,
        offset: Int = 0,
        device: String? = null,
    ): ItemsPage =
        withContext(Dispatchers.IO) {
            val root = base()
            val qs = buildString {
                append("pinned=$pinned&limit=$limit&offset=$offset")
                if (!device.isNullOrBlank()) append("&device=${java.net.URLEncoder.encode(device, "UTF-8")}")
            }
            val req = Request.Builder()
                .url("$root/api/items?$qs")
                .get()
                .build()
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw IllegalStateException("Items ${res.code}")
                json.decodeFromString<ItemsPage>(res.body!!.string())
            }
        }

    suspend fun fetchDevices(): List<DeviceInfo> = withContext(Dispatchers.IO) {
        val root = base()
        val req = Request.Builder().url("$root/api/devices").get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return@withContext emptyList()
            json.decodeFromString<DevicesResponse>(res.body!!.string()).devices
        }
    }

    suspend fun createText(content: String, deviceName: String, pinned: Boolean = false, label: String? = null): ClipItem =
        withContext(Dispatchers.IO) {
            val root = base()
            val payload = buildMap {
                put("content", content)
                put("deviceName", deviceName)
                put("pinned", pinned)
                if (!label.isNullOrBlank()) put("label", label)
            }
            val body = encodeMap(payload).toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url("$root/api/items/text").post(body).build()
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw IllegalStateException("createText ${res.code}")
                json.decodeFromString<ClipItem>(res.body!!.string())
            }
        }

    suspend fun uploadBytes(
        bytes: ByteArray,
        filename: String,
        mimeType: String,
        deviceName: String,
        pinned: Boolean = false,
    ): ClipItem = withContext(Dispatchers.IO) {
        val root = base()
        val fileBody = bytes.toRequestBody(mimeType.toMediaType())
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, fileBody)
            .addFormDataPart("deviceName", deviceName)
            .addFormDataPart("pinned", pinned.toString())
            .build()
        val req = Request.Builder().url("$root/api/items/upload").post(multipart).build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("upload ${res.code}")
            json.decodeFromString<ClipItem>(res.body!!.string())
        }
    }

    suspend fun touch(id: String): ClipItem = withContext(Dispatchers.IO) {
        val root = base()
        val req = Request.Builder().url("$root/api/items/$id/touch").post(ByteArray(0).toRequestBody()).build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("touch ${res.code}")
            json.decodeFromString<ClipItem>(res.body!!.string())
        }
    }

    suspend fun updateItem(id: String, pinned: Boolean? = null, label: String? = null): ClipItem =
        withContext(Dispatchers.IO) {
            val root = base()
            val payload = buildMap {
                if (pinned != null) put("pinned", pinned)
                if (label != null) put("label", label)
            }
            val body = encodeMap(payload).toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url("$root/api/items/$id").patch(body).build()
            client.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw IllegalStateException("update ${res.code}")
                json.decodeFromString<ClipItem>(res.body!!.string())
            }
        }

    suspend fun deleteItem(id: String) = withContext(Dispatchers.IO) {
        val root = base()
        val req = Request.Builder().url("$root/api/items/$id").delete().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("delete ${res.code}")
        }
    }

    suspend fun downloadBlob(id: String): ByteArray = withContext(Dispatchers.IO) {
        val root = base()
        val req = Request.Builder().url("$root/api/items/$id/blob").get().build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("blob ${res.code}")
            res.body!!.bytes()
        }
    }

    suspend fun joinPair(serverUrl: String, code: String): JoinResult = withContext(Dispatchers.IO) {
        val root = serverUrl.trimEnd('/')
        val body = encodeMap(mapOf("code" to code)).toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$root/api/pair/join").post(body).build()
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("Código inválido")
            json.decodeFromString<JoinResult>(res.body!!.string())
        }
    }

    fun blobUrl(itemId: String, serverUrl: String): String =
        "${serverUrl.trimEnd('/')}/api/items/$itemId/blob"

    fun okHttp(): OkHttpClient = client
    fun jsonCodec(): Json = json

    private fun encodeMap(map: Map<String, Any?>): String {
        val obj = kotlinx.serialization.json.buildJsonObject {
            map.forEach { (k, v) ->
                when (v) {
                    null -> put(k, kotlinx.serialization.json.JsonNull)
                    is Boolean -> put(k, kotlinx.serialization.json.JsonPrimitive(v))
                    is Number -> put(k, kotlinx.serialization.json.JsonPrimitive(v))
                    else -> put(k, kotlinx.serialization.json.JsonPrimitive(v.toString()))
                }
            }
        }
        return obj.toString()
    }
}
