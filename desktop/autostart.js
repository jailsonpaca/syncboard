const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function getLauncher() {
  try {
    const { app } = require('electron');
    if (app?.isPackaged) {
      if (process.platform === 'linux') {
        const wrapper = path.join(os.homedir(), '.local/bin/syncboard');
        if (fs.existsSync(wrapper)) return wrapper;
      }
      return process.execPath;
    }
  } catch { /* ok */ }
  return path.join(__dirname, 'launch.sh');
}

function getIcon() {
  try {
    const { app } = require('electron');
    if (app?.isPackaged) {
      return path.join(process.resourcesPath, 'icons', 'tray-32.png');
    }
  } catch { /* ok */ }
  return path.join(__dirname, 'icons', 'tray-32.png');
}

function macPlistPath() {
  return path.join(os.homedir(), 'Library/LaunchAgents/com.syncboard.desktop.plist');
}

function linuxDesktopPath() {
  return path.join(os.homedir(), '.config/autostart/syncboard.desktop');
}

function isEnabled() {
  if (process.platform === 'darwin') return fs.existsSync(macPlistPath());
  if (process.platform === 'linux') return fs.existsSync(linuxDesktopPath());
  return false;
}

function writeMacPlist() {
  const plist = macPlistPath();
  const launcher = getLauncher();
  fs.mkdirSync(path.dirname(plist), { recursive: true });

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.syncboard.desktop</string>
  <key>ProgramArguments</key>
  <array>
    <string>${launcher}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), 'Library/Logs/syncboard.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), 'Library/Logs/syncboard.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

  fs.writeFileSync(plist, content);
  try {
    execSync(`launchctl unload "${plist}" 2>/dev/null; launchctl load "${plist}"`, { stdio: 'ignore', shell: true });
  } catch { /* ok */ }
}

function removeMacPlist() {
  const plist = macPlistPath();
  if (!fs.existsSync(plist)) return;
  try { execSync(`launchctl unload "${plist}"`, { stdio: 'ignore' }); } catch { /* ok */ }
  fs.unlinkSync(plist);
}

function writeLinuxDesktop() {
  const desktop = linuxDesktopPath();
  const launcher = getLauncher();
  const icon = getIcon();
  fs.mkdirSync(path.dirname(desktop), { recursive: true });

  const iconLine = fs.existsSync(icon) ? `Icon=${icon}\n` : '';
  const content = `[Desktop Entry]
Type=Application
Name=SyncBoard
Comment=Clipboard sync na rede local
Exec=${launcher}
${iconLine}Terminal=false
Categories=Utility;
StartupNotify=false
Hidden=false
X-GNOME-Autostart-enabled=true
`;

  fs.writeFileSync(desktop, content);

  const appsDir = path.join(os.homedir(), '.local/share/applications');
  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(path.join(appsDir, 'syncboard.desktop'), content);

  try {
    execSync('update-desktop-database "$HOME/.local/share/applications" 2>/dev/null', {
      shell: true,
      stdio: 'ignore',
    });
  } catch { /* ok */ }
}

function removeLinuxDesktop() {
  for (const p of [linuxDesktopPath(), path.join(os.homedir(), '.local/share/applications/syncboard.desktop')]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function setEnabled(enabled) {
  if (process.platform === 'darwin') {
    if (enabled) writeMacPlist();
    else removeMacPlist();
    return;
  }
  if (process.platform === 'linux') {
    if (enabled) writeLinuxDesktop();
    else removeLinuxDesktop();
  }
}

module.exports = { isEnabled, setEnabled, getLauncher };
