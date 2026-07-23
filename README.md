# SyncBoard

Clipboard compartilhado na sua Wi‑Fi — sincroniza **texto, imagens e arquivos** entre Mac, Linux e Android, sem nuvem.

## Baixar

Página de download (seu domínio): configure em [`website/`](website/) e [`release.config.json`](release.config.json).

Binários e updates: **GitHub Releases** (publicados automaticamente ao criar uma tag `v*`).

```bash
# Publicar nova versão
node scripts/bump-version.js 1.1.0
git add -A && git commit -m "release: v1.1.0"
git tag v1.1.0
git push origin main --tags
```

## Instalação rápida (desenvolvimento / rede local)

```bash
cd ~/mesa/projects/syncboard
./install.sh
```

| Plataforma | Onde fica | Atalho |
|------------|-----------|--------|
| **Mac** | Barra de menu | `Alt+V` (⌥V) |
| **Linux** | System tray | `Alt+V` |
| **Android** | Chrome → IP do servidor → Tela inicial | — |

## Pareamento (sem digitar IP)

1. Na máquina **servidor**, ative “Servidor local”.
2. Abra SyncBoard → ⚙ → painel **Conectar dispositivos** (código + QR).
3. No outro aparelho:
   - **Desktop:** Preferências → cole o código → **Parear**
   - **Android/web:** ⚙ → “Entrar com código” ou escaneie o QR

Os dispositivos precisam estar na **mesma Wi‑Fi**.

## Atualizações

- **App Electron:** verifica o GitHub Releases e avisa no menu/tray (“Nova versão — baixar/instalar”). Cliente + servidor embutido atualizam juntos.
- **Servidor standalone / UI web:** banner “Nova versão” com link para a página de download.
- Preferência: “Buscar atualizações automaticamente” (ligada por padrão).

## Configuração típica

### Máquina principal (servidor)
1. Instale o app e mantenha **Servidor local** ativo.
2. Mostre o **código/QR** aos outros dispositivos.

### Segundo desktop (cliente)
1. Instale o app.
2. Preferências → desmarque “Servidor local” → **Parear** com o código.

### Android
1. Escaneie o QR (ou abra `http://IP:8787`).
2. Chrome → **Adicionar à tela inicial**.

## Comandos

```bash
./install.sh          # Instala + autostart + toolbar
npm run desktop       # App Electron
npm run dev           # Server + client (hot reload)
npm run build:release # Empacota Mac/Linux + latest.json
./start.sh            # Só o servidor
```

## Estrutura

```
syncboard/
├── desktop/    # Electron — tray, clipboard, updater, pareamento
├── server/     # API + WebSocket + SQLite + pair UDP + update check
├── client/     # UI web (PWA)
├── website/    # Landing de download (seu domínio)
├── .github/    # CI de release
└── scripts/    # bump-version, latest.json
```

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | 8787 | Porta do servidor |
| `HOST` | 0.0.0.0 | Interface de bind |
| `SYNCBOARD_DATA` | server/data | Pasta de dados |
| `SYNCBOARD_GH_OWNER` / `SYNCBOARD_GH_REPO` | release.config.json | Repo dos updates |

## Nota Mac (Gatekeeper)

Sem notarização Apple, na primeira abertura use **Clique direito → Abrir**. Updates in-app funcionam mesmo assim.

## Firewall (Linux)

```bash
sudo ufw allow 8787/tcp
sudo ufw allow 18787/udp   # discovery do código de pareamento
```
