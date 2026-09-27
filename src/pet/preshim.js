'use strict';

/**
 * 必须在上游脚本**之前**执行。
 *
 * 上游把余额接口写死成 `http://127.0.0.1:3020/balance`，而桌面版希望它可配置
 * （不是每个人都跑着那个本机余额代理）。这里装一个 fetch 垫片，把那个固定 URL
 * 重写到设置里的 `whale-moe:balanceEndpoint`。
 *
 * 这样 vendor/whale 依旧零改动，其它请求也完全不受影响（只匹配那一个地址）。
 */
(function () {
  'use strict';

  const HARDCODED = '127.0.0.1:3020/balance';
  const nativeFetch = window.fetch.bind(window);

  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf(HARDCODED) !== -1) {
        const custom = (localStorage.getItem('whale-moe:balanceEndpoint') || '').trim();
        if (custom && custom !== url) {
          return nativeFetch(custom, init);
        }
      }
    } catch (error) {
      /* 读存储失败就原样放行 */
    }
    return nativeFetch(input, init);
  };
})();
