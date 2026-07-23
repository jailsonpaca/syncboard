(function () {
  const cfg = window.SYNCBOARD_SITE || { owner: 'jailsonpaca', repo: 'syncboard' };
  const gh = `https://github.com/${cfg.owner}/${cfg.repo}`;
  const api = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`;

  const $ = (id) => document.getElementById(id);
  const btnMac = $('btn-mac');
  const btnWindows = $('btn-windows');
  const btnLinux = $('btn-linux');
  const btnAndroid = $('btn-android');
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

  function bind(btn, url, soonLabel) {
    if (url) {
      btn.href = url;
      btn.classList.remove('is-disabled');
      btn.removeAttribute('aria-disabled');
      return true;
    }
    disable(btn, soonLabel);
    return false;
  }

  async function load() {
    try {
      const latestUrl = `${gh}/releases/latest/download/latest.json`;
      let macUrl = null;
      let winUrl = null;
      let linuxUrl = null;
      let androidUrl = null;
      let version = null;

      try {
        const lr = await fetch(latestUrl, { headers: { Accept: 'application/json' } });
        if (lr.ok) {
          const latest = await lr.json();
          version = latest.version;
          macUrl = latest.assets?.macDmg || latest.assets?.macZip;
          winUrl = latest.assets?.winSetup || latest.assets?.winZip;
          linuxUrl = latest.assets?.linuxAppImage || latest.assets?.linuxTar;
          androidUrl = latest.assets?.androidApk || null;
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
          (n) => /-mac\.zip$/i.test(n),
        ]);
        winUrl = pickAsset(assets, [
          (n) => /\.exe$/i.test(n),
          (n) => /-win\.zip$/i.test(n),
        ]);
        linuxUrl = pickAsset(assets, [
          (n) => /\.AppImage$/i.test(n),
          (n) => /\.tar\.gz$/i.test(n),
        ]);
        androidUrl = pickAsset(assets, [(n) => /\.apk$/i.test(n)]);
      }

      versionLine.textContent = version
        ? `Versão ${version} · links do GitHub Releases`
        : 'Release ainda não publicada';
      footerVer.textContent = version ? `v${version}` : '';

      bind(btnMac, macUrl, 'Mac em breve');
      bind(btnWindows, winUrl, 'Windows em breve');
      bind(btnLinux, linuxUrl, 'Linux em breve');
      bind(btnAndroid, androidUrl, 'Android em breve');
    } catch (err) {
      console.warn(err);
      versionLine.textContent =
        'Não foi possível carregar o release. Veja o GitHub ou publique a tag v*.';
      btnMac.href = `${gh}/releases`;
      btnWindows.href = `${gh}/releases`;
      btnLinux.href = `${gh}/releases`;
      btnAndroid.href = `${gh}/releases`;
    }
  }

  load();
})();
