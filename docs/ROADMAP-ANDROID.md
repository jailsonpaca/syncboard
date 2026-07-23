# Roadmap — SyncBoard Android (nativo)

Status: **planejado / ainda indisponível**

## Decisões

- App **nativo Kotlin + Jetpack Compose**, cliente LAN apenas (sem servidor embutido).
- Build **local** (`./scripts/build-android.sh`); **fora** do GitHub Actions.
- APK leve: R8/minify, preferência por ABI `arm64-v8a`, sem Firebase/ads.
- Distribuir via **GitHub Releases** + `latest.json` (`androidApk`) — **não** versionar `.apk` no git.

## MVP

- Parear por código / QR
- Histórico + Fixo
- Sync de **texto**
- Sync de **imagem** (clipboard em foreground + screenshots)

## Imagens e screenshots

Sim, é possível — com ressalvas do Android:

1. **Clipboard nativo**  
   Se a imagem estiver no clipboard (`ClipData` com imagem/URI), o SyncBoard em **primeiro plano** pode ler e enviar ao servidor (igual ao desktop).

2. **Screenshot → clipboard**  
   Em vários aparelhos o print vai para a galeria **e** às vezes para o clipboard — isso **varia por fabricante/versão**. Não é garantia universal.

3. **Restrição importante**  
   Desde Android 10+, app em **background** quase não consegue monitorar o clipboard continuamente (política do sistema). Por isso o sync “automático o tempo todo” como no Electron é limitado.

4. **Caminho mais confiável para screenshot**  
   Observar a pasta/MediaStore de **Screenshots** (novo arquivo) e sincronizar a imagem — costuma ser mais estável do que depender só do clipboard.

### Estratégia sugerida no app

| Situação | Comportamento |
|----------|----------------|
| App aberto / em uso | Ler clipboard (texto + imagem) periodicamente ou ao ganhar foco |
| Novo screenshot na galeria | Detectar via MediaStore e oferecer sync (ou sync automático opcional) |
| App em background | Sem poll agressivo de clipboard; notificação/serviço só se o usuário ativar |

## Fora do escopo inicial

- Servidor Node dentro do APK  
- Build Android no CI  
- App na Play Store (pode vir depois; release via site/GitHub primeiro)
