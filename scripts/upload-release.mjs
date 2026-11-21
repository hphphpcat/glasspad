// 把 release/ 下当前版本的安装包上传到 GitHub Release（hphphpcat/glasspad，tag 固定为 glasspad），
// 并把 Release 标题改为「GlassPad v<版本>」。
// 用法：node scripts/upload-release.mjs ["更新说明第 1 条" "第 2 条" ...]
// Token 来源：环境变量 GITHUB_TOKEN / GH_TOKEN，否则从 git credential（macOS 钥匙串）读取。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'hphphpcat/glasspad';
const TAG = 'glasspad';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('password='));
  if (!line) throw new Error('没有找到 GitHub token：请设置 GITHUB_TOKEN，或先在 git 里登录 github.com');
  return line.slice('password='.length).trim();
}

const headers = {
  Authorization: `Bearer ${getToken()}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'glasspad-release-uploader',
};

const files = [
  { name: `GlassPad-${version}-arm64.dmg`, type: 'application/octet-stream' },
  { name: `GlassPad-${version}-portable.exe`, type: 'application/vnd.microsoft.portable-executable' },
].map((f) => ({ ...f, filePath: path.join(root, 'release', f.name) }));

for (const f of files) {
  if (!fs.existsSync(f.filePath)) {
    throw new Error(`缺少 ${f.filePath}，请先运行 npm run dist 和 npm run dist:win`);
  }
}

const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers });
if (!relRes.ok) throw new Error(`获取 Release 失败: ${relRes.status} ${await relRes.text()}`);
const release = await relRes.json();

for (const f of files) {
  const existing = (release.assets || []).find((a) => a.name === f.name);
  if (existing) {
    const del = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE', headers });
    if (!del.ok) throw new Error(`删除旧附件 ${f.name} 失败: ${del.status}`);
    console.log('已删除同名旧附件:', f.name);
  }
  const data = fs.readFileSync(f.filePath);
  const up = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(f.name)}`,
    { method: 'POST', headers: { ...headers, 'Content-Type': f.type, 'Content-Length': String(data.length) }, body: data },
  );
  if (!up.ok) throw new Error(`上传 ${f.name} 失败: ${up.status} ${await up.text()}`);
  const asset = await up.json();
  console.log('已上传:', asset.name, asset.size, 'bytes', asset.browser_download_url);
}

const notes = process.argv.slice(2);
const patch = { name: `GlassPad v${version}` };
if (notes.length > 0) {
  patch.body = [`### v${version} 更新内容`, ...notes.map((n, i) => `${i + 1}. ${n}`)].join('\n');
}
const pr = await fetch(`https://api.github.com/repos/${REPO}/releases/${release.id}`, {
  method: 'PATCH',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});
if (!pr.ok) throw new Error(`更新 Release 标题失败: ${pr.status} ${await pr.text()}`);
const updated = await pr.json();
console.log('Release 已更新:', updated.name, updated.html_url);
