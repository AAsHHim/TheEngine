/**
 * Returns HTML to inject as the first child of <head>: a script that rewrites
 * navigation, fetch, XHR, forms, and WebSockets to stay on the proxy origin.
 *
 * Uses same-origin-relative paths (/proxy?url=...) so navigation works inside
 * iframes and when the server-injected base URL does not match window.location
 * (e.g. preview ports, Codespaces, meta api-base).
 */
function getInterceptScript(baseProxyUrl, currentTargetUrl) {
  return `<script id="__theengine_intercept__">
(function() {
  const CURRENT_FALLBACK = ${JSON.stringify(currentTargetUrl)};

  /** Upstream page URL for resolving relative paths — read from iframe location ?url= after each navigation. */
  function currentTargetUrl() {
    try {
      var u = new URL(window.location.href);
      var raw = u.searchParams.get('url');
      if (raw) return decodeURIComponent(raw);
    } catch (e) {}
    return CURRENT_FALLBACK;
  }

  function wsOriginFromLocation() {
    try {
      var o = window.location.origin;
      var u = new URL(o);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return u.origin;
    } catch (e) {
      try {
        var b = new URL(${JSON.stringify(baseProxyUrl)});
        b.protocol = b.protocol === 'https:' ? 'wss:' : 'ws:';
        return b.origin;
      } catch (e2) {
        return 'ws://localhost';
      }
    }
  }

  function isExternal(url) {
    return url && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//'));
  }

  function resolve(url) {
    try {
      return new URL(url, currentTargetUrl()).href;
    } catch (e) {
      return url;
    }
  }

  /** Always same-origin relative so iframe / preview / port-forward never mismatch injected BASE. */
  function proxyUrl(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('mailto:')) return url;
    if (url.indexOf('/proxy?url=') !== -1) return url;
    var abs = resolve(url);
    if (!abs.startsWith('http')) return url;
    return '/proxy?url=' + encodeURIComponent(abs);
  }

  function proxyApiUrl(url) {
    var abs = resolve(String(url));
    if (!abs.startsWith('http')) return abs;
    return '/proxy/api?url=' + encodeURIComponent(abs);
  }

  const origLocation = window.location;
  try {
    Object.defineProperty(window, 'location', {
      get() { return origLocation; },
      set(v) { window.location.href = proxyUrl(String(v)); }
    });
  } catch (e) {}

  const origAssign = window.location.assign.bind(window.location);
  const origReplace = window.location.replace.bind(window.location);
  try {
    window.location.assign = function(url) { return origAssign(proxyUrl(url)); };
    window.location.replace = function(url) { return origReplace(proxyUrl(url)); };
  } catch (e) {}

  const origPush = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = function(state, title, url) {
    return origPush(state, title, url ? proxyUrl(url) : url);
  };
  history.replaceState = function(state, title, url) {
    return origReplaceState(state, title, url ? proxyUrl(url) : url);
  };

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (input instanceof Request) {
      var req = input;
      var u = req.url;
      if (isExternal(u)) {
        var newUrl = proxyApiUrl(u);
        try {
          var cloned = req.clone();
          return origFetch(new Request(newUrl, cloned));
        } catch (e1) {
          try {
            return origFetch(new Request(newUrl, req));
          } catch (e2) {
            return origFetch(newUrl, init);
          }
        }
      }
      return origFetch(input, init);
    }
    var url = String(input);
    if (isExternal(url)) {
      return origFetch(proxyApiUrl(url), init);
    }
    return origFetch(input, init);
  };

  var origOpen = window.open;
  window.open = function(url, target, features) {
    if (url != null && url !== '') {
      var s = String(url);
      if (isExternal(s)) {
        return origOpen.call(window, proxyUrl(s), target, features);
      }
    }
    return origOpen.call(window, url, target, features);
  };

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function(method, url, async, user, password) {
      if (isExternal(String(url))) {
        url = proxyApiUrl(url);
      }
      return origOpen(method, url, async, user, password);
    };
    return xhr;
  };

  const observer = new MutationObserver(function(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.querySelectorAll) {
          node.querySelectorAll('a[href]').forEach(function(a) {
            const href = a.getAttribute('href');
            if (isExternal(href)) a.setAttribute('href', proxyUrl(href));
          });
          node.querySelectorAll('form[action]').forEach(function(f) {
            const action = f.getAttribute('action');
            if (isExternal(action)) f.setAttribute('action', proxyUrl(action));
          });
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('submit', function(e) {
    const form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    const action = form.action || currentTargetUrl();
    if (isExternal(action) && action.indexOf('/proxy?url=') === -1) {
      e.preventDefault();
      const proxiedAction = proxyUrl(action);
      const clone = form.cloneNode(true);
      clone.action = proxiedAction;
      clone.style.display = 'none';
      document.body.appendChild(clone);
      clone.submit();
    }
  }, true);

  const OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const u = String(url);
    if (!/^wss?:\\/\\//i.test(u)) {
      return protocols !== undefined ? new OrigWS(u, protocols) : new OrigWS(u);
    }
    const wsProxyUrl = wsOriginFromLocation() + '/proxy/ws/' + encodeURIComponent(u);
    try {
      return protocols !== undefined ? new OrigWS(wsProxyUrl, protocols) : new OrigWS(wsProxyUrl);
    } catch (e) {
      return protocols !== undefined ? new OrigWS(u, protocols) : new OrigWS(u);
    }
  };
  window.WebSocket.prototype = OrigWS.prototype;
  window.WebSocket.CONNECTING = OrigWS.CONNECTING;
  window.WebSocket.OPEN = OrigWS.OPEN;
  window.WebSocket.CLOSING = OrigWS.CLOSING;
  window.WebSocket.CLOSED = OrigWS.CLOSED;
})();
</script>`;
}

module.exports = { getInterceptScript };
