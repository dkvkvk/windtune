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
  /* JOOX 官方搜索（免登录，实测 30 条，带 1000px 封面）
   * 用途：JOOX 搜索/封面的首选，GD 只剩「歌词 + 歌单」用得上。
   * 参数：?country=hk&lang=zh_TW&key=<关键词>&type=0
   * 返回：{ tracks: [ [ {id, name, artist_list[], album_name, play_duration, images[] } ] ] }
   * 注意：取流接口 api.joox.com/web-fcgi-bin/web_get_songinfo 已 404 下线（2026-11 实测），
   *       JOOX 音频本来就没有可用通道，只做搜索/歌词/封面。
   */
  jooxSearch: 'https://cache.api.joox.com/openjoox/v2/search_type',

  /* 网易云官方增强播放接口（**免登录**，比 GD 稳定得多，实测 fee=8 也能给 320k）
   * 用途：网易云直链的**首选**；GD 只作为它的备用。
   * 参数：?ids=[歌曲id]&br=320000（注意 br 单位是 bps，不是 kbps）
   * 返回：data[0].url / .br / .size / .code（code=404 表示该曲目取不到）
   */
  neteaseUrl: 'https://music.163.com/api/song/enhance/player/url',
  /* 网易云搜索的降级通道：官方 /api/search/get/web 有频控（连续请求返回
   * code=405「操作频繁，请稍候再试」），被限时用这个老接口顶上。 */
  neteaseSearchLegacy: 'https://music.163.com/api/search/get',
  neteaseSearch: 'https://music.163.com/api/search/get/web',
  neteaseDetail: 'https://music.163.com/api/song/detail',
  neteaseLyric: 'https://music.163.com/api/song/lyric',
  neteasePlaylist: 'https://music.163.com/api/v6/playlist/detail',

  /* ---------------- 酷我 ----------------
   * 现状：搜索/直链/歌词/封面 全部正常（直链只给 mp3，是最宽容的兜底源）
   */
  kuwoSearch: 'http://search.kuwo.cn/r.s',
  kuwoUrl: 'http://antiserver.kuwo.cn/anti.s',
  /* 波点音乐（酷我旗下免费 app）取流接口 —— 实测免登录给 320k mp3 和 FLAC
   * 用途：酷我直链的**首选**（比 anti.s 的 128k mp3 高两个档），anti.s 降为备用。
   * 参数：?br=2000kflac|320kmp3|128kmp3&musicId=<酷我 rid>&timestamp=<ms>&sign=<md5>
   * 签名算法见 src/sources.js 的 bodianSign()：md5('kuwotest' + 参数乱序重排 + pathname)
   * 前置条件：先 POST bodianAd 领一次「看广告免广告/VIP」，有效期 30 分钟。
   * 失效表现：code=20018「没有解锁付费歌曲」（没领豁免）、code=20012「歌曲已下线」（该 rid 无版权）
   */
  bodianUrl: 'http://bd-api.kuwo.cn/api/play/music/v2/audioUrl',
  bodianAd: 'http://bd-api.kuwo.cn/api/service/advert/watch',
  kuwoInfo: 'http://m.kuwo.cn/newh5/singles/songinfoandlrc', // 歌词 + 封面（http）
  kuwoInfoSsl: 'https://m.kuwo.cn/newh5/singles/songinfoandlrc', // 上一条的 https 备用
  kuwoPlaylist: 'http://nplserver.kuwo.cn/pl.svc', // 现状：已失效，对任何 pid 都返回 total:0

  /* ---------------- QQ 音乐 ----------------
   * 现状：搜索/歌词/歌单/专辑 正常；直链需要登录态，取不到（走补链）
   */
  /* QQ 搜索（**真搜索**，不是联想建议）
   * 老接口 c.y.qq.com/soso/fcgi-bin/client_search_cp 已 500 下线，
   * 之前退而求其次用的 smartbox_new.fcg 是输入框联想接口——「晴天 周杰伦」只回 1 条，
   * 这就是「QQ 搜不到歌」的原因。本接口实测 10 条，带专辑名与时长。
   * 注意：origin 必须是 http://（写 https 会返回 0 条，踩过）。
   */
  qqSearch: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
  /* QQ 联想建议接口：真搜索被限流（search.code=2001）时的兜底。
   * 它返回条数很少（「晴天 周杰伦」只有 1 条），只当降级方案，不要当主搜索。 */
  qqSuggest: 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg',
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
  kugouSongInfo: 'https://m.kugou.com/app/i/getSongInfo.php',
  /* 酷狗移动版搜索（mobilecdn）：比 WebFilter 多给 320hash / sqhash，
   * 用途：取流失败时补齐无损/320 hash 再试一次（UNM 用的也是这个）。
   * 参数：?keyword=<关键词>&page=1&pagesize=10
   */
  kugouCdnSearch: 'http://mobilecdn.kugou.com/api/v3/search/song', // 直链方案三（社区通用，需移动端 UA）

  /* ---------------- 咪咕 ----------------
   * 现状：本机返回 0 条，可用性随地区/风控波动，标为「尽力而为」
   */
  miguSearch: 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do',
};

module.exports = { EP };
