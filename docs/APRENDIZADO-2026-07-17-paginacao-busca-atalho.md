# Aprendizado SyncBoard — 17/07/2026

Documento de sessão: melhorias de desempenho, UX e release empacotado (Mac + Linux).

## Contexto

Projeto em `~/mesa/projects/syncboard` (clipboard sync local entre Mac, Linux e Android).

Pedido do usuário:

1. Paginação nos itens copiados (desempenho)
2. Ao clicar em item antigo → ir para posição mais recente (lista + clipboard)
3. Abrir mais rápido pelo atalho (Mac e Linux)
4. Limitar histórico a 100 itens (limpar os mais antigos)
5. Remover sessão “Cole aqui” + campo de texto
6. No lugar: busca + filtros (imagem, arquivo, vídeo, etc.)
7. Depois: build/release real (sem modo dev), disponibilizar install no Linux, e salvar este aprendizado em MD

---

## Arquitetura relevante

| Parte | Caminho | Papel |
|---|---|---|
| UI (React/Vite) | `client/` | Lista, busca, filtros, paginação |
| API + SQLite | `server/` | Persistência, trim, touch, paginação |
| Electron | `desktop/main.js` | Tray, atalho, clipboard nativo, popup |
| Daemon server Mac | LaunchAgent `com.syncboard.server` | Serve API + `client/dist` + `/downloads` |
| Releases | `desktop/release/` | `.dmg`, `.app`, `.AppImage`, `.tar.gz` |

UI do app empacotado carrega de `http://localhost:8787` (servidor). Por isso rebuild do **server + client** e do **Electron** precisam ficar alinhados.

---

## Mudanças implementadas

### 1. Paginação (server + client)

- `GET /api/items` passa a retornar `{ items, total, limit, offset }`
- Query params: `limit`, `offset`, `q` (busca), `type` (`all|text|image|video|file`)
- Compatibilidade tray/desktop: `?flat=true` ainda devolve array puro
- UI: página de 20 itens + botão “Carregar mais”

Arquivos: `server/src/store.ts`, `server/src/routes.ts`, `client/src/api.ts`, `client/src/App.tsx`

### 2. Clique promove item (bump / touch)

- Endpoint `POST /api/items/:id/touch` atualiza `updated_at = now`
- Também aceito via `PATCH` com `{ bump: true }`
- Electron (`pasteItemIntoFocus` / tray): chama touch antes de copiar/colar
- Web/Android: `touchItem()` + `copyItemToClipboard()`
- Resultado: item sobe na listagem e vai para o clipboard do SO

### 3. Atalho mais rápido (Mac/Linux)

Problema anterior: cada atalho criava `BrowserWindow` nova e dava `loadURL` → atraso perceptível.

Solução:

- Janela compacta **pré-criada** no `app.whenReady` (`ensureCompactWindow`)
- Em blur/close: **esconde** em vez de destruir
- Atalho só faz `show()` + `focus()` (+ `app.focus` no Mac)
- `backgroundThrottling: false` na janela compacta
- `mainWindow` e `compactWindow` separados (não compartilham mais um único handle)

Arquivo: `desktop/main.js`

### 4. Limite de 100 itens

- Constante `MAX_HISTORY_ITEMS = 100` em `store.ts`
- `trimHistory()` remove excedentes **e** apaga blobs em disco
- Notifica clientes via `item_deleted` quando trim acontece no create
- Trim também roda no construtor do store (migração 200 → 100)

### 5. UI: busca + filtros no lugar do “Cole aqui”

Removido:

- Zona “Cole aqui”
- Textarea / botão Enviar
- Upload de arquivo daquela faixa (sync continua via clipboard nativo do Electron)

Adicionado:

- Campo de busca (debounce ~200ms)
- Chips: Todos / Texto / Imagem / Vídeo / Arquivo
- Vídeo = `type=file` + `mime_type LIKE 'video/%'`

CSS: `.search-zone`, `.filter-chip`, `.pagination` (substitui `.paste-zone`)

---

## Release empacotado (sem modo dev)

### Comando de build

```bash
cd ~/mesa/projects/syncboard
./build-release.sh
```

O script:

1. `npm run build` (client + server)
2. Copia `server/dist` + `client/dist` para `desktop/resources/`
3. Rebuild de `better-sqlite3` para a versão do Electron
4. `electron-builder` → Mac (dmg/zip) + Linux (AppImage + tar.gz)
5. Gera alias `SyncBoard-linux-x64.tar.gz` (nome estável do install Linux)
6. Atualiza IP nos scripts `install-*.sh` da pasta `release/`

### Instalação no Mac (esta sessão)

```bash
rm -rf /Applications/SyncBoard.app
cp -R desktop/release/mac/SyncBoard.app /Applications/
xattr -cr /Applications/SyncBoard.app
launchctl kickstart -k "gui/$(id -u)/com.syncboard.server"
open -a /Applications/SyncBoard.app
```

Validação rápida:

- `ensureCompactWindow` presente no `app.asar`
- `curl http://localhost:8787/api/health`
- Downloads: `http://localhost:8787/downloads/install-linux.sh`
- Downloads: `http://localhost:8787/downloads/SyncBoard-linux-x64.tar.gz`

### Linux — comando para rodar no PC Linux

**Recomendado** (tar nativo, servido pelo SyncBoard na :8787):

```bash
curl -fsSL http://192.168.3.93:8787/downloads/install-linux.sh | bash
```

Alternativa AppImage (precisa `npm run serve:releases` no Mac na :8788):

```bash
curl -fsSL http://192.168.3.93:8788/install-appimage-linux.sh | bash
```

Se o IP do Mac mudar:

```bash
SYNCBOARD_MAC_IP=IP.DO.MAC curl -fsSL http://IP.DO.MAC:8787/downloads/install-linux.sh | bash
```

Pré-requisito: SyncBoard (servidor) online no Mac na porta 8787; Linux e Mac na mesma rede.

---

## Armadilhas / lições

1. **Não confundir Electron “dev” com app empacotado**  
   Rodar `electron .` no `desktop/` usa `main.js` do fonte, mas `/Applications/SyncBoard.app` só atualiza após `build-release` + cópia/instalação. Para “app certinho”, sempre empacotar.

2. **UI vem do servidor**  
   LaunchAgent aponta `SYNCBOARD_CLIENT_DIST` para `client/dist`. Rebuild do client + restart do daemon atualiza a interface mesmo sem reinstalar o `.app` — mas mudanças de atalho/clipboard **exigem** novo Electron.

3. **API quebrando o tray**  
   Mudar `/items` de array para objeto paginado quebra o menu da tray se não houver `flat=true` (ou parser que aceite ambos). Sempre manter compatibilidade.

4. **Trim sem apagar blob**  
   Só `DELETE` no SQLite deixa arquivos órfãos em `blobs/`. Trim deve remover blob junto.

5. **Build `--omit=dev` no server**  
   O `build-release.sh` faz `npm install --omit=dev` no server (para embutir runtime). Depois disso, `tsc` some até rodar `npm install` de novo no `server/` — lembrar de restaurar deps de desenvolvimento após o release.

6. **Dois canais de install Linux**  
   - `:8787/downloads/` → `install-linux.sh` + `SyncBoard-linux-x64.tar.gz` (preferido)  
   - `:8788/` → AppImage + `install-appimage-linux.sh` (`npm run serve:releases`)

7. **Atalho lento = criar janela**  
   Pré-aquecer e só `show/hide` é o ganho real; otimizar React ajuda pouco se o gargalo é `new BrowserWindow` + `loadURL`.

---

## Arquivos tocados nesta sessão

- `server/src/store.ts` — listPage, touch, trim 100 + blobs
- `server/src/routes.ts` — paginação, filtros, `/touch`, `flat`
- `client/src/types.ts` — `TypeFilter`, `ItemsPage`
- `client/src/api.ts` — fetch paginado, `touchItem`
- `client/src/App.tsx` — busca, filtros, paginação, bump no clique
- `client/src/index.css` — search/filters/pagination
- `desktop/main.js` — compact window pré-carregada, bump, `flat=true`
- `build-release.sh` — AppImage + tar.gz + scripts install

---

## Checklist pós-release

- [x] `./build-release.sh` OK
- [x] `/Applications/SyncBoard.app` atualizado
- [x] Daemon server reiniciado
- [x] `/downloads/install-linux.sh` e `SyncBoard-linux-x64.tar.gz` HTTP 200
- [x] AppImage disponível em `desktop/release/`
- [ ] No Linux: rodar o curl de install e validar atalho `Ctrl+Shift+V`

---

## Comandos úteis

```bash
# Build completo
cd ~/mesa/projects/syncboard && ./build-release.sh

# Reiniciar só o servidor
launchctl kickstart -k "gui/$(id -u)/com.syncboard.server"

# Servir pasta release na :8788
npm run serve:releases

# Health
curl -s http://localhost:8787/api/health
```
