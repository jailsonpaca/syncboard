const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');

function isPackaged() {
  return app?.isPackaged ?? false;
}

function resourcePath(...parts) {
  if (isPackaged()) {
    return path.join(process.resourcesPath, ...parts);
  }
  return path.join(ROOT, ...parts);
}

function serverDistPath() {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'server', 'dist', 'index.js');
  }
  return path.join(ROOT, 'server', 'dist', 'index.js');
}

function serverCwd() {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'server');
  }
  return path.join(ROOT, 'server');
}

function clientDistPath() {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'client');
  }
  return path.join(ROOT, 'client', 'dist');
}

function userDataPath() {
  return path.join(app.getPath('userData'), 'data');
}

module.exports = {
  isPackaged,
  resourcePath,
  serverDistPath,
  serverCwd,
  clientDistPath,
  userDataPath,
  ROOT,
};
