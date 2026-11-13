/**
 * @name 网易云官方直连（内置示例音源）
 * @description 用网易云官方接口取直链。可以拿它当模板，改成 QQ/酷狗/酷我
 * @version 1.0.0
 * @author WindTune
 * @homepage https://github.com/dkvkvk/windtune
 *
 * 这个文件同时是「自定义音源」的活文档：
 *   - 脚本通过 globalThis.lx 跟主程序通信
 *   - send(EVENT_NAMES.inited, {...}) 声明自己支持哪些平台
 *   - on(EVENT_NAMES.request, handler) 处理取地址请求，**必须返回 Promise**
 *   - 发网络请求用 globalThis.lx.request(url, options, callback)，不要用 fetch
 *     （只有 lx.request 会走主程序的超时/取消/User-Agent 处理）
 *
 * 平台 key：wy=网易云  tx=QQ音乐  kg=酷狗  kw=酷我  mg=咪咕
 *
 * 想让它支持 QQ/酷狗，把 sources 里的 key 换成 tx / kg，
 * 再在 musicUrl 里换成你自己的取流接口即可（参考 examples/ 目录里的模板）。
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

/** 包一层：把回调式的 lx.request 变成 Promise */
const http = (url, options) => new Promise((resolve, reject) => {
  request(url, options, (err, resp) => {
    if (err) return reject(err)
    resolve(resp && resp.body)
  })
})

const apis = {
  wy: {
    /** info = { songmid, name, singer, albumName, interval, id, ... } */
    musicUrl(info, quality) {
      const id = info.id || info.songmid
      const br = quality === 'flac' ? 999000 : quality === '320k' ? 320000 : 128000
      const url = 'https://music.163.com/api/song/enhance/player/url?ids=[' + id + ']&br=' + br
      return http(url, {
        headers: { Cookie: 'os=pc; appver=9.0.0', Referer: 'https://music.163.com/' },
        timeout: 15000,
      }).then((body) => {
        const j = JSON.parse(body)
        const d = j && j.data && j.data[0]
        if (!d || !d.url) return Promise.reject(new Error('这个音质取不到，换一档试试'))
        return d.url
      })
    },
  },
}

on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('本示例只实现了 musicUrl'))
  const api = apis[source]
  if (!api) return Promise.reject(new Error('不支持这个平台：' + source))
  return api.musicUrl(info.musicInfo, info.type)
})

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    wy: {
      name: '网易云音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac'],
    },
  },
})
