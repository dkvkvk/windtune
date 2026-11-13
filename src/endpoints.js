'use strict';
/**
 * 听风音乐舫 · 全部外部接口地址（唯一定义处）
 * ================================================
 * 这些接口**都不是官方开放平台**：没有文档、没有 key、没有承诺。
 * 平台改版时它们会失效，这是这类工具的常态，不是 bug。
 *
 * 【接口失效时怎么办】
 *   1. 先跑 `npm run check-api`，它会告诉你哪一条死了、死在哪一步；
 *   2. 只改本文件里对应的那一行（改完立刻生效，不用碰适配器代码）；
 *   3. 再跑一次 `npm run check-api` 确认活了；
 *   4. 如果地址没变但还是死的（参数/签名/风控变了），才需要去
 *      src/sources.js 里改参数——每个函数上方都注明了它用哪条接口。
 *
 * 【免责】
 *   本项目不绕过付费/登录，取不到就是取不到，会如实跳过并记进 _跳过清单.txt。
 */

const EP = {
  /* ---------------- GD 音乐台（第三方公益聚合） ----------------
   * 用途：网易云 与 JOOX 的 搜索 / 直链 / 歌词 / 封面 / 歌单
   * 参数：?types=search|url|lyric|pic|playlist & source=netease|joox & ...
   * 现状：正常。只支持 netease 与 joox 两个 source。
   * 失效影响：**最大单点**——网易云和 JOOX 会一起废，补链后端只剩酷我。
   */
  gd: 'https://music-api.gdstudio.xyz/api.php',

  /* 网易云官方增强播放接口（**免登录**，比 GD 稳定得多，实测 fee=8 也能给 320k）
   * 用途：网易云直链的**首选**；GD 只作为它的备用。
   * 参数：?ids=[歌曲id]&br=320000（注意 br 单位是 bps，不是 kbps）
   * 返回：data[0].url / .br / .size / .code（code=404 表示该曲目取不到）
   */
  neteaseUrl: 'https://music.163.com/api/song/enhance/player/url',
  neteaseSearch: 'https://music.163.com/api/search/get/web',
  neteaseDetail: 'https://music.163.com/api/song/detail',
  neteaseLyric: 'https://music.163.com/api/song/lyric',
  neteasePlaylist: 'https://music.163.com/api/v6/playlist/detail',

  /* ---------------- 酷我 ----------------
   * 现状：搜索/直链/歌词/封面 全部正常（直链只给 mp3，是最宽容的兜底源）
   */
  kuwoSearch: 'http://search.kuwo.cn/r.s',
  kuwoUrl: 'http://antiserver.kuwo.cn/anti.s',
  kuwoInfo: 'http://m.kuwo.cn/newh5/singles/songinfoandlrc', // 歌词 + 封面（http）
  kuwoInfoSsl: 'https://m.kuwo.cn/newh5/singles/songinfoandlrc', // 上一条的 https 备用
  kuwoPlaylist: 'http://nplserver.kuwo.cn/pl.svc', // 现状：已失效，对任何 pid 都返回 total:0

  /* ---------------- QQ 音乐 ----------------
   * 现状：搜索/歌词/歌单/专辑 正常；直链需要登录态，取不到（走补链）
   */
  qqSearch: 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg',
  qqLyric: 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg',
  qqPlaylist: 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg',
  qqAlbum: 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg',
  qqVkey: 'https://u.y.qq.com/cgi-bin/musicu.fcg', // 直链：VIP 歌 purl 为空

  /* ---------------- 酷狗 ----------------
   * 现状：搜索/歌单/歌词 正常；直链需要签名，取不到（走补链）
   */
  kugouSearch: 'https://songsearch.kugou.com/song_search_v2',
  kugouPlaylist: 'http://mobilecdn.kugou.com/api/v3/special/song',
  kugouLyricSearch: 'https://krcs.kugou.com/search',
  kugouLyricDown: 'https://lyrics.kugou.com/download',
  kugouTrackercdn: 'https://trackercdn.kugou.com/i/v2/', // 直链方案一（现状：需登录）
  kugouApi: 'https://wwwapi.kugou.com/yy/index.php', // 直链方案二（现状：err 30020）
  kugouSongInfo: 'https://m.kugou.com/app/i/getSongInfo.php', // 直链方案三（社区通用，需移动端 UA）

  /* ---------------- 咪咕 ----------------
   * 现状：本机返回 0 条，可用性随地区/风控波动，标为「尽力而为」
   */
  miguSearch: 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do',
};

module.exports = { EP };
