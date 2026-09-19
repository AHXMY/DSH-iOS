# 远程能力代理 · 部署

手机版 DSH 有两样东西天生缺，靠两个零依赖的小服务补回来：

| 服务 | 补什么 | 为什么需要 |
| --- | --- | --- |
| `exec-agent.mjs` | shell / git / 真实文件树 | iOS 不给子进程，本地永远跑不了命令 |
| `search-agent.mjs` | 联网搜索 | 模型自带的搜索要用服务端工具，未必人人可用、未必这张网络里通 |

两个都是**一个文件、零依赖**，丢到自己的 Linux 机器上跑就行。

---

## 一、执行代理（exec-agent.mjs）

iOS 不给子进程，所以手机上的 agent 永远跑不了 shell / git。**这个代理就是把那半边能力拿回来的方式**：
你在一台自己的 Linux 机器上跑它，手机只发 HTTP，agent 就能在上面跑命令、用 git、处理真实文件树。

它不是什么新东西 —— 桌面版 DSH 里的 `bash` / 文件工具本来就有，这里只是把"执行的那一头"
挪到了一台 iOS 管不到的机器上。协议只有五个端点，零依赖，一个文件。

### 一分钟跑起来（先在本机验证）

```bash
# 1. 随便找个目录当工作区，起一个带 token 的代理
DSH_EXEC_TOKEN=$(head -c 24 /dev/urandom | base64) \
DSH_EXEC_ROOT=$HOME/dsh-workspace \
node server/exec-agent.mjs

# 它会打印：dsh-exec-agent 1.0.0 监听 http://127.0.0.1:7717
```

然后在 App 的「设置 → 远程执行」里填 `http://127.0.0.1:7717`（真机测试时换成人那台机器的地址）
和上面那个 token，点「测试执行代理」——应当回「连上了（linux，/root/dsh-workspace）；命令可执行」。

## 丢到服务器上（推荐：你自己的 VPS）

```bash
# 1. 拉文件（或直接把 server/exec-agent.mjs 传上去）
sudo mkdir -p /opt/dsh-exec /srv/dsh-exec
sudo cp exec-agent.mjs /opt/dsh-exec/

# 2. 生成 token 并写进环境文件（只有 root 能读）
head -c 32 /dev/urandom | base64 | tr -d '\n' | sudo tee /etc/dsh-exec.env >/dev/null
sudo chmod 600 /etc/dsh-exec.env

# 3. 装 systemd 单元（见 dsh-exec-agent.service）
sudo cp dsh-exec-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-exec-agent
systemctl status dsh-exec-agent --no-pager

# 4. 本机自测
TOKEN=$(sudo cat /etc/dsh-exec.env)
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:7717/health
```

## 从手机怎么连上去（三条路，按安全性排序）

### 路线 A：Tailscale（最省心，推荐）

```bash
# 服务器与 iPhone 都装 Tailscale 并登录同一 tailnet
sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:7717
```

得到的地址是 `https://<机器名>.<tailnet>.ts.net`，**证书是正式签发的**（Let's Encrypt），
手机侧不用装任何描述文件，也不怕网络环境变化。App 里就填这个地址。

### 路线 B：并入现有 nginx 门禁（你已经在用 18080 那套）

把 `nginx-exec-location.conf` 里的片段并进你的 server 块（它复用同一个 `dshg` cookie 门禁）：

```bash
sudo cp nginx-exec-location.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

之后手机填 `https://<你的域名或IP>:18080/exec`。
**注意：如果用的是自签证书，iPhone 会拒绝**（Safari 能点"继续访问"，App 的 fetch 不能）。
要么在 iPhone 上装一次证书描述文件并在「关于本机 → 证书信任设置」里打开，要么走路线 A。

### 路线 C：局域网直连（只在开发时用）

代理绑到 `0.0.0.0`，手机填 `http://<你电脑的局域网 IP>:7717`。
明文 HTTP 只适合在可信局域网里临时用；App 的 iOS 侧为此开了 `NSAllowsLocalNetworking`
（只放行局域网明文，公网仍然强制 HTTPS）。

## 安全边界（别改成"方便"的样子）

| 保证 | 做法 |
| --- | --- |
| 必须有 token | 没 token 直接拒绝启动；恒定时间比较，防时序侧信道 |
| 默认不对外 | 默认只绑 `127.0.0.1`，要暴露必须自己套 TLS 门禁或 Tailscale |
| 路径锁死 | 所有文件操作限制在 `DSH_EXEC_ROOT` 内，含符号链接逃逸检查 |
| 有上限 | 请求体 4MB、输出各 64KB、命令超时上限 10 分钟 |
| 不吞资源 | 超时连**整个进程树**一起杀（Windows 用 taskkill /T，POSIX 杀进程组） |

它确实能在那台机器上执行任意命令 —— 这是它存在的意义，所以**权限就是那台机器上那个用户的权限**。
建议用独立用户跑、`DSH_EXEC_ROOT` 指到一个专用目录，别拿 root 跑在重要机器上。

## 协议（想自己实现一份也行）

```
GET    /health                        → { ok, root, platform, version }
POST   /exec    {command,cwd?,timeoutMs?} → { stdout, stderr, exitCode, durationMs, timedOut }
GET    /file?path=<相对路径>           → 纯文本
PUT    /file    {path,content,append?} → { bytes, path }
DELETE /file?path=<相对路径>           → { removed }
GET    /tree?path=<相对路径>&depth=N   → { root, entries:[{path,type,size}] }
鉴权：authorization: Bearer <token>（所有端点）
错误：非 2xx + { "error": "人话说明" }
```

客户端在 `src/agent/sandbox.ts`，只依赖这五个端点 —— 换一家实现（E2B、Daytona、你自己的容器）
只要照着这套接口包一层，上层工具与提示词都不用动。

---

## 二、搜索代理（search-agent.mjs）

模型自己的联网搜索走服务端工具（DeepSeek 那套是 Anthropic 兼容端点上的 `web_search`），
**未必人人可用**；而且"抓搜索页"这件事很挑网络。这个代理把搜索搬到你自己的机器上，
不依赖任何第三方搜索 API key，只要那台机器能上网。

### 引擎是实测挑的，不是按名气挑的

在**这台机器所在的网络**里实测（2026-09 复现）：

| 引擎 | 结果 |
| --- | --- |
| **Bing（`?format=rss`）** | ✅ 200，纯 XML，10 条结果，**返回真实 URL** —— 默认用它 |
| **搜狗** | ✅ 200，服务端渲染的结果页，链接是 210 字节的跳转页（能还原真实地址）—— 备用 |
| DuckDuckGo | ❌ 12 秒无响应 |
| Brave Search | ❌ 10 秒无响应 |
| 360 搜索 | ❌ 16 秒无响应 |
| 百度 | ⚠️ 302 到验证页，不做 |

选 Bing 的 RSS 输出还有个额外好处：**RSS 是给聚合器用的稳定契约**，
抓 HTML 则是抓给浏览器看的东西，前端一改版就失效。

### 跑起来

```bash
DSH_SEARCH_TOKEN=$(head -c 24 /dev/urandom | base64) \
  node server/search-agent.mjs --engine bing

# 自测（本机）
TOKEN=<上面的 token>
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:7718/search?q=deepseek&limit=3"
```

App 里「设置 → 联网搜索 → 自建搜索代理」，填地址、token，选引擎（`bing` / `sogou`）。
想换机器/换端口就改地址；要暴露到公网，套 nginx 门禁或 Tailscale（跟执行代理一样）。

### 协议

```
GET /health                                  → { ok, version, engines, defaultEngine }
GET /search?q=…&limit=8&engine=bing&resolve=1 → { query, engine, took, results:[{title,url,snippet,publishedAt?}] }
鉴权：authorization: Bearer <token>
错误：非 2xx + { "error": "人话说明" }（上游挂了给 502/504，并带上上游状态码）
```

`resolve=0` 可以关掉搜狗链接还原（省一条小请求，但结果里会留 `/link?url=` 跳转链接）。

### 真实性的边界

解析器是对着**真实抓下来的页面**验的（`fixtures/` 里三份：Bing RSS、搜狗结果页、搜狗跳转页），
端到端那一组则是对着 mock 引擎跑。但搜索引擎随时可能改版或限流 ——
所以解析不到结果时代理会返回 502 并明说"可能改版或被限流，换 engine=sogou 或稍后再试"，
而不是静默返回空列表。
