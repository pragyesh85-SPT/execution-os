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
  "asar": true,
  "compression": "normal"
};

module.exports.directories.output = process.env.EOS_BUILD_DIR ? `${buildDir}/release` : 'release';
if (process.env.EOS_ELECTRON_CACHE) module.exports.electronDownload = { cache: process.env.EOS_ELECTRON_CACHE };
