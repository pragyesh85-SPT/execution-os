// electron-builder configuration (Windows EXE).
// Output folder and Electron download cache can be moved with environment variables,
// e.g. to another drive: EOS_BUILD_DIR=D:/eos-build  EOS_ELECTRON_CACHE=D:/eos-build/electron-cache
const buildDir = process.env.EOS_BUILD_DIR || 'release';

module.exports = {
  "appId": "com.pragyesh.executionos",
  "productName": "Execution OS",
  "copyright": "Pragyesh Jain",
  "directories": {
    "buildResources": "build-res"
  },
  "files": [
    "dist/**/*",
    "build/**/*",
    "package.json"
  ],
  "extraResources": [
    {
      "from": "extension",
      "to": "extension"
    },
    {
      "from": "templates/study-vault",
      "to": "templates/study-vault"
    }
  ],
  "win": {
    "icon": "build-res/icon.ico",
    "signAndEditExecutable": true
  },
  "portable": {
    "artifactName": "ExecutionOS-${version}-portable.exe"
  },
  "nsis": {
    "artifactName": "ExecutionOS-${version}-setup.exe",
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true
  },
  // Auto-update (NSIS installer only): electron-updater reads app-update.yml generated from this.
  // Builds use --publish never; the release workflow attaches the files to the GitHub Release.
  "publish": [{ "provider": "github", "owner": "pragyesh85-SPT", "repo": "execution-os", "releaseType": "release" }],
  "asar": true,
  // The `study` CLI runs outside the app window (vault shims, Task Scheduler) with Execution OS.exe in
  // Node mode, so its single-file bundle sits next to app.asar instead of inside it.
  "asarUnpack": ["build/study.cjs"],
  "compression": "normal"
};

module.exports.directories.output = process.env.EOS_BUILD_DIR ? `${buildDir}/release` : 'release';
if (process.env.EOS_ELECTRON_CACHE) module.exports.electronDownload = { cache: process.env.EOS_ELECTRON_CACHE };
