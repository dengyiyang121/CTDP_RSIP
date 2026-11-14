# 部署到 GitHub Pages + 两台设备共用一份账本

三句话先说清：

- 这个 App 是**纯静态**的，GitHub Pages 免费托管，不需要服务器。
- **代码**放公开仓库（Pages 要求公开，免费账户）；**账本**必须放另一个**私有**仓库。
- 每台设备各自配置一次令牌（PAT），之后自动同步。

---

## 1. 部署到 Pages

### 路线 A：网页上传（不装任何东西，推荐）

1. GitHub 右上角 `+` → **New repository**，名字随意（比如 `zuozhan`），选 **Public**，不要勾 README。
2. 打开电脑上的 `projects\self-control-app\dist` 文件夹。
3. 在仓库页面点 **uploading an existing file**，把 `dist` 里的**所有内容**拖进去：
   - `assets/`（整个文件夹）
   - `index.html`、`manifest.webmanifest`、`sw.js`、`README.md`、`.nojekyll`
4. **Commit changes**。
5. 仓库 **Settings → Pages** → Source 选 `Deploy from a branch` → Branch `main`，目录 `/ (root)` → **Save**。
6. 等约 1 分钟，打开 `https://<用户名>.github.io/<仓库名>/`。

> `.nojekyll` 是隐藏文件。Windows 资源管理器要先在「查看」里勾上「隐藏的项目」。漏了也能跑，只是 Pages 会多走一遍 Jekyll。

### 路线 B：一条命令

```powershell
# 先在 GitHub 建一个空仓库（Public）
cd projects\self-control-app
.\deploy.ps1 -Repo https://github.com/<用户名>/<仓库名>.git
```

第一次会弹浏览器让你登录 GitHub（Git Credential Manager 处理，不用手打密码）。
之后每次更新版本，再跑一次同样的命令即可。

---

## 2. 装到手机

1. 手机浏览器打开 Pages 地址。
2. Chrome：菜单 → **添加到主屏幕 / 安装应用**（HTTPS 下才出现）。
   iOS Safari：分享 → **添加到主屏幕**。
3. 装好之后断网也能打开（Service Worker 缓存）。

---

## 3. 两台设备共用一份账本

1. 再建一个仓库，名字比如 `ctdp-ledger`，**必须选 Private**。不用建任何文件，App 第一次上传会自动创建。
2. 生成令牌：头像 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
   - **Repository access**：Only select repositories → 只选 `ctdp-ledger`
   - **Permissions → Repository permissions → Contents**：改成 **Read and write**（其它保持 No access）
   - **Expiration**：90 天（到期重新生成一次即可）
   - 生成后复制 `github_pat_...`（只显示这一次）
   - **不要把这个令牌贴在聊天/截图里**；如果贴过，去 GitHub 撤销重发一个。
3. 在 App 里：**档案 → 云同步**
   - 仓库：`你的用户名/ctdp-ledger`
   - 文件路径：`ledger/state.json`
   - 分支：`main`
   - 令牌：粘贴
   - **测试连接** → 应该提示「连上了：xxx → xxx/ctdp-ledger（私有）」
   - **保存并同步**（会自动完成第一次上传/合并）
4. 另一台设备：**档案 → 云同步 → 输入同步码**，把第一台设备面板里的同步码贴进来即可（不用再找令牌）；也可以手动填四个字段。

之后的行为（v0.5.1 起）：

- 打开 App / 回到前台 / 恢复联网 → 自动拉一次。
- 改动后约 2.5 秒自动上传，不需要手动点。
- 两边都改过 → **自动合并**，不再弹“选哪边”。判例/喜报/链/国策都不丢；删除会同步，不会复活。
- 断网 → 本地照常记；联网后自动补传，失败会每 20 秒重试。
- 每次上传都是一次 commit，真出问题还能在仓库历史里回滚。

### 旧数据迁移（这次同步事故）

`localhost` 与 Pages 域名的 `localStorage` 互不相通。这次从本机浏览器里恢复出了一份账本：

- `backups/recovered-ledger-2026-11-11.json`

在新地址（或手机）：**档案 → 导入备份** → 选这个文件 → 再点「立即同步」。
导入会覆盖当前账本，导入前 App 会先在本机留一份自动快照。

如果还有更早的旧账本：在旧地址 **档案 → 导出 JSON**，到新地址 **导入备份**。

---

## 4. 安全

- 令牌只存在这台设备的 `localStorage`，**不会写进账本、不会被同步**。
- 令牌只需要一个私有仓库的 Contents 权限，泄露了影响面也只有这一个仓库。
- 别在公共电脑上配置；换设备时在 GitHub 上把旧令牌撤销即可。

---

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| 打开还是旧界面 | 档案 → **强制更新（清缓存并重载）**，或连按两次刷新 |
| 测试连接 401 | 令牌过期或复制不全，重新生成 |
| 测试连接 404 | 仓库名写错（要 `owner/repo`），或令牌没勾这个仓库 |
| 测试连接 403 | 权限不够：Contents 必须是 Read and write；或触到限流 |
| 手机上不出现「安装」 | 必须 HTTPS（Pages 是）；iOS 用 Safari 的「添加到主屏幕」 |
| 状态条写「同步失败」 | 本地照常可用；点状态条重试，或 **同步体检** 看具体错误（401/403/404/网络） |
| 手机看不到电脑的新改动 | 打开手机 App 就会自动拉；也可以点「立即同步」。两台都要刷到 0.5.1 |
| 提示“云端刚变过” | 不用管，App 已自动重拉合并再推；下次同步会显示已合并 |
