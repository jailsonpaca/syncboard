-keepattributes *Annotation*, InnerClasses
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class com.syncboard.android.data.** { *; }
-keepclassmembers class * {
    @kotlinx.serialization.Serializable <fields>;
}
