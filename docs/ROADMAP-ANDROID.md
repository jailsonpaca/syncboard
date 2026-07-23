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
- **Monitorar imagens recentes** (MediaStore) para capturar screenshots
- Aparecer no **Share** do sistema (compartilhar para o SyncBoard)

## Imagens e screenshots

Sim, é possível — com ressalvas do Android:

1. **Clipboard nativo**  
   Se a imagem estiver no clipboard (`ClipData` com imagem/URI), o SyncBoard em **primeiro plano** pode ler e enviar ao servidor (igual ao desktop).

2. **Screenshot → clipboard**  
   Em vários aparelhos o print vai para a galeria **e** às vezes para o clipboard — isso **varia por fabricante/versão**. Não é garantia universal.

3. **Restrição importante**  
   Desde Android 10+, app em **background** quase não consegue monitorar o clipboard continuamente (política do sistema). Por isso o sync “automático o tempo todo” como no Electron é limitado.

4. **Caminho principal para screenshot: imagens recentes**  
   Observar o **MediaStore** (e/ou pasta Screenshots) por **arquivos de imagem novos/recentes**. Quando surgir um print (ou outra imagem salva), o SyncBoard “pega” e sincroniza com o servidor.  
   Mais estável do que depender só do clipboard. Preferência opcional do usuário: sync automático vs. perguntar antes.

### Estratégia sugerida no app

| Situação | Comportamento |
|----------|----------------|
| App aberto / em uso | Ler clipboard (texto + imagem) periodicamente ou ao ganhar foco |
| Nova imagem recente / screenshot | Detectar via MediaStore (imagens recentes) e sync (auto ou com confirmação) |
| App em background | Sem poll agressivo de clipboard; watcher de mídia só com permissão e preferência ligada |
| Usuário usa “Compartilhar” | SyncBoard aparece na lista e recebe o arquivo |

## Share do sistema (intent de compartilhar)

O app deve registrar-se como destino no **menu Compartilhar** do Android (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`), para o usuário enviar direto ao SyncBoard:

- imagens  
- vídeos  
- documentos / arquivos genéricos  
- texto (quando fizer sentido)

Fluxo: galeria, Files, Chrome, etc. → **Compartilhar** → **SyncBoard** → upload para o servidor pareado (histórico), pronto para colar nos outros dispositivos.

Tipos MIME sugeridos no manifesto: `image/*`, `video/*`, `application/*`, `text/plain` (ajustar conforme o MVP de arquivos).

## Fora do escopo inicial

- Servidor Node dentro do APK  
- Build Android no CI  
- App na Play Store (pode vir depois; release via site/GitHub primeiro)
