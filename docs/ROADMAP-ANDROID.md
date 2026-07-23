# Roadmap — SyncBoard Android (nativo)

Status: **implementado (MVP)** — build e publish locais

## Decisões

- App **nativo Kotlin + Jetpack Compose**, cliente LAN apenas (sem servidor embutido).
- Build **local** (`./scripts/build-android.sh`); **fora** do GitHub Actions.
- APK leve: R8/minify, ABI `arm64-v8a`, sem Firebase/ads.
- Distribuir via **GitHub Releases** + `latest.json` (`androidApk`) — **não** versionar `.apk` no git.

## Entregue no MVP

- [x] Parear por código / QR (UDP + HTTP)
- [x] Histórico + Fixo + WebSocket
- [x] Sync de texto/imagem via clipboard (foreground)
- [x] Monitorar imagens recentes / screenshots (MediaStore) — modos OFF / ASK / AUTO
- [x] Share sheet (`SEND` / `SEND_MULTIPLE`)
- [x] Scripts `build-android.sh` + `publish-android-apk.sh`

## Próximos aprimoramentos

- FileProvider para colar imagem nativa no clipboard do Android
- Assinatura release com keystore dedicado
- Play Store (opcional)
- Reduzir deps de câmera/ML Kit se quiser APK ainda menor (QR só por digitação)

## Build

```bash
./scripts/build-android.sh
./scripts/publish-android-apk.sh vX.Y.Z
```
