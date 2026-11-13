# 自定义音源

这个目录放的 `.js` 文件会被程序当成**音源脚本**加载（格式与[洛雪音乐](https://github.com/lyswhut/lx-music-desktop)的自定义源完全一致，社区现成的音源可以直接用）。

## 为什么需要它

QQ音乐 / 酷狗的音频接口锁在登录态后面，而且各家接口平均几个月改一次。把它们硬编码进程序，意味着每次失效都要等发新版。
音源脚本把「取音频地址」这一层独立出来——接口变了，你换一个脚本就行，不用重装。

> 程序仍然保留内置通路：网易云、酷我 不装音源也能下（官方接口直连）。
> 音源是在这之上的**增强**：让 QQ / 酷狗 这类需要登录态的平台也能拿到整首音频。

## 放哪里

| 位置 | 用途 |
|---|---|
| `%APPDATA%\windtune\sources\` | **你自己装音源放这里**（软件里点右上角「音源」按钮直接打开） |
| 软件安装目录的 `sources\` | 随包内置（目前只有一个示例音源） |

放进去后重启软件，右上角会显示「音源 N」，点一下能看到目录；`npm run check-api` 也会列出加载结果和失败原因。

## 怎么写

看 `demo-netease.js`（能直接用）和 `examples/` 里的模板。核心就三件事：

```js
const { EVENT_NAMES, request, on, send } = globalThis.lx

// 1. 声明支持哪些平台
send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    tx: { name: 'QQ音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
  },
})

// 2. 收到取地址请求
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('未实现'))
  return getUrl(info.musicInfo, info.type)   // 必须返回 Promise，值是字符串 URL
})

// 3. 发请求用 lx.request，不要用 fetch
function getUrl(musicInfo, quality) {
  return new Promise((resolve, reject) => {
    request('https://…', { timeout: 15000 }, (err, resp) => {
      if (err) return reject(err)
      resolve(JSON.parse(resp.body).url)
    })
  })
}
```

平台 key：`wy`=网易云 `tx`=QQ音乐 `kg`=酷狗 `kw`=酷我 `mg`=咪咕

`info.musicInfo` 里有的字段：

| 通用 | 平台专有 |
|---|---|
| `name` `singer` `albumName` `interval` `img` `source` `songmid` `id` | `tx`: `songmid` `strMediaMid` `albumMid` `songId`　`kg`: `hash`(小写) `audioId`　`kw`: `musicrid`　`mg`: `copyrightId` |

可用的 `lx.utils`：`buffer.from` / `buffer.bufToString` / `crypto.md5` / `crypto.aesEncrypt` / `crypto.rsaEncrypt` / `crypto.randomBytes` / `zlib.inflate` / `zlib.deflate`。

## ⚠️ 安全

音源脚本是**任意 JavaScript**，跑起来拥有和本程序同样的权限（和洛雪一样，这是这个机制固有的代价）。
**只放你自己信任的脚本**，别从来源不明的群文件、短链接下载。

## 出问题怎么看

1. `npm run check-api` —— 会现场加载一遍并打印每个脚本的失败原因（语法错误、没发 `inited`、平台不认识…）
2. 软件启动后看日志 `[音源] ✓ 名字` / `[音源] ✗ 名字 → 原因`
3. 音源加载成功但下载失败：多半是脚本里的接口也挂了 —— 换一个音源，或者按脚本里的注释改接口地址
