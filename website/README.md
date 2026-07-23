# SyncBoard — site de download

Landing estática que lê a última release do GitHub e monta os botões Mac/Linux.

## Configurar

1. Edite [`config.js`](config.js): `owner`, `repo` e `downloadUrl` (seu domínio).
2. Espelhe os mesmos valores em [`../release.config.json`](../release.config.json).
3. Publique esta pasta no seu domínio (Cloudflare Pages, Vercel, Netlify ou qualquer static host).

### Cloudflare Pages (exemplo)

- Build command: _(nenhum)_
- Output directory: `website`
- Custom domain: `syncboard.jpinnovation.com.br`

## Fluxo de release

```bash
# na raiz do repo
node scripts/bump-version.js 1.1.0
git tag v1.1.0
git push origin v1.1.0
```

O workflow `.github/workflows/release.yml` gera os binários e o `latest.json`.
Esta página passa a apontar automaticamente para os novos arquivos.
