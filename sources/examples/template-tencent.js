/**
 * @name 我的QQ音乐音源（模板）
 * @description 把下面的 TODO 换成你自己的取流接口，这个文件就能用了
 * @version 1.0.0
 * @author 你的名字
 *
 * 用法：改好之后把文件名改成 tx-我的音源.js，放到 %APPDATA%\windtune\sources\ 目录，
 *      重启软件，右上角「检测平台」里会显示已加载的音源。
 *
 * 平台 key：wy=网易云  tx=QQ音乐  kg=酷狗  kw=酷我  mg=咪咕
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

const http = (url, options) => new Promise((resolve, reject) => {
  request(url, options, (err, resp) => {
    if (err) return reject(err)
    resolve(resp && resp.body)
  })
})

const apis = {
  tx: {
    /**
     * info 里的字段（由主程序填好）：
     *   通用     name / singer / albumName / interval / img / source / songmid / id
     *   tx 平台  songmid（就是 QQ 的 songmid）、strMediaMid、albumMid、songId
     */
    musicUrl(info, quality) {
      // TODO 1：把这里换成你那个平台的取流接口
      const url = 'https://你的接口地址?keyword=' + encodeURIComponent(info.name + ' ' + info.singer)

      return http(url, {
        // TODO 2：需要 cookie 就在这里带上（cookie 要你自己登录后复制，程序不内置任何账号）
        // headers: { Cookie: 'uin=你的uin; qqmusic_key=你的key' },
        timeout: 15000,
      }).then((body) => {
        const j = JSON.parse(body)
        const realUrl = j.url || (j.data && j.data.url)
        if (!realUrl) return Promise.reject(new Error('没取到地址：' + JSON.stringify(j).slice(0, 200)))
        return realUrl
      })
    },
  },
}

on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('本模板只实现了 musicUrl'))
  const api = apis[source]
  if (!api) return Promise.reject(new Error('不支持这个平台：' + source))
  return api.musicUrl(info.musicInfo, info.type)
})

send(EVENT_NAMES.inited, {
  openDevTools: false,
  sources: {
    tx: {
      name: 'QQ音乐',
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac'],
    },
  },
})
