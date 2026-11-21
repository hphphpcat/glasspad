const { execFileSync } = require('child_process');
const path = require('path');

// electron-builder 钩子：macOS 打包生成 GlassPad.app 后自动清除扩展属性并做 ad-hoc 签名，
// 防止因 identity: null 导致二级框架签名与主程序不一致而在其它 Mac 上弹出「已损坏」
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  try {
    execFileSync('xattr', ['-cr', appPath]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
    console.log(`[afterPack] Ad-hoc signed & cleared xattr for: ${appPath}`);
  } catch (err) {
    console.warn(`[afterPack] warning:`, err.message);
  }
};
