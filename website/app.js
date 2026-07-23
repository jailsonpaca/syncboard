(function () {
  const cfg = window.SYNCBOARD_SITE || { owner: 'jailsonpaca', repo: 'syncboard' };
  const gh = `https://github.com/${cfg.owner}/${cfg.repo}`;
  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`;

  const $ = (id) => document.getElementById(id);
  const btnMac = $('btn-mac');
  const btnLinux = $('btn-linux');
  const versionLine = $('version-line');
  const footerVer = $('footer-ver');
  const githubLink = $('github-link');

  githubLink.href = gh;

  function pickAsset(assets, tests) {
    for (const test of tests) {
      const hit = assets.find((a) => test(a.name || ''));
      if (hit) return hit.browser_download_url;
    }
    return null;
  }

  function disable(btn, label) {
    btn.classList.add('is-disabled');
    btn.setAttribute('aria-disabled', 'true');
    if (label) btn.textContent = label;
  }

  async function load() {
    try {
      // Tenta latest.json primeiro (URLs estáveis do nosso manifesto)
      const latestUrl = `${gh}/releases/latest/download/latest.json`;
      let macUrl = null;
      let linuxUrl = null;
      let version = null;

      try {
        const lr = await fetch(latestUrl, { headers: { Accept: 'application/json' } });
        if (lr.ok) {
          const latest = await lr.json();
          version = latest.version;
          macUrl = latest.assets?.macDmg || latest.assets?.macZip;
          linuxUrl = latest.assets?.linuxAppImage || latest.assets?.linuxTar;
        }
      } catch {
        /* fallback API */
      }

      if (!version) {
        const res = await fetch(api, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) throw new Error(`GitHub API ${res.status}`);
        const data = await res.json();
        version = String(data.tag_name || '').replace(/^v/, '');
        const assets = data.assets || [];
        macUrl = pickAsset(assets, [
          (n) => /\.dmg$/i.test(n),
          (n) => /\.zip$/i.test(n) && /mac|darwin/i.test(n),
          (n) => /\.zip$/i.test(n),
        ]);
        linuxUrl = pickAsset(assets, [
          (n) => /\.AppImage$/i.test(n),
          (n) => /linux/i.test(n) && /\.tar\.gz$/i.test(n),
          (n) => /\.tar\.gz$/i.test(n),
        ]);
      }

      versionLine.textContent = version
        ? `Versão ${version} · links direto do GitHub Releases`
        : 'Release ainda não publicada';
      footerVer.textContent = version ? `v${version}` : '';

      if (macUrl) {
        btnMac.href = macUrl;
      } else {
        disable(btnMac, 'Mac em breve');
      }

      if (linuxUrl) {
        btnLinux.href = linuxUrl;
      } else {
        disable(btnLinux, 'Linux em breve');
      }
    } catch (err) {
      console.warn(err);
      versionLine.textContent =
        'Não foi possível carregar o release. Veja o GitHub ou publique a tag v*.';
      btnMac.href = `${gh}/releases`;
      btnLinux.href = `${gh}/releases`;
    }
  }

  load();
})();
