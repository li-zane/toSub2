"""Offline regressions for browser fallback and isolated OAuth sessions."""
import importlib.util
from http.cookiejar import Cookie, CookieJar
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("oauth_test_worker", Path(__file__).resolve().parents[1] / "src/tls_transport.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

sessions = []


class Cookies:
    def __init__(self):
        self.jar = CookieJar()

    def clear(self):
        self.jar.clear()


class Session:
    def __init__(self, **options):
        self.options = options
        self.cookies = Cookies()
        self.requests = []
        sessions.append(self)

    def close(self):
        pass

    def request(self, method, url, **options):
        if self.options.get("impersonate") == "chrome146":
            raise RuntimeError("Impersonating chrome146 is not supported")
        self.requests.append((method, url, options))
        return SimpleNamespace(status_code=200, headers={}, content=b"{}")


module.requests = SimpleNamespace(Session=Session)
module.IMPORT_ERROR = None
worker = module.Worker()
worker.configure("http://proxy.example:8080", "chrome146")
cookie = Cookie(0, "fixture", "private", None, False, "auth.openai.com", False, False, "/", True, True, None, True, None, None, {})
worker.session.cookies.jar.set_cookie(cookie)
worker.request({
    "method": "GET", "url": "https://auth.openai.com/choose-an-account",
    "headers": [["user-agent", "Mozilla/5.0 Chrome/146.0.0.0"], ["sec-ch-ua", '"Chromium";v="146", "Google Chrome";v="146"']],
})
assert worker.impersonate == "chrome145"
assert list(worker.session.cookies.jar)[0].value == "private"
headers = worker.session.requests[-1][2]["headers"]
assert "Chrome/145." in headers["user-agent"], headers
assert 'v="146"' not in headers["sec-ch-ua"], headers
assert 'v="145"' in headers["sec-ch-ua"], headers
coherent = worker._coherent_browser_headers({
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/99.0.0.0",
    "sec-ch-ua-platform": '"Windows"',
})
assert "Macintosh; Intel Mac OS X 10_15_7" in coherent["user-agent"]
assert coherent["sec-ch-ua-platform"] == '"macOS"'

browser_session = worker.session
result = worker.request({
    "requestKind": "oauth", "method": "POST", "url": "https://auth.openai.com/oauth/token",
    "headers": [["user-agent", "toSub2"], ["accept", "application/json"], ["content-type", "application/json"],
                ["cookie", "private=one"], ["origin", "https://auth.openai.com"], ["sec-ch-ua", '"Chromium";v="145"']],
})
assert worker.session is browser_session
assert worker.oauth_session is not browser_session
assert worker.oauth_session.options == {"default_headers": False, "proxy": "http://proxy.example:8080"}
assert len(list(browser_session.cookies.jar)) == 1
assert len(list(worker.oauth_session.cookies.jar)) == 0
request = worker.oauth_session.requests[-1][2]
assert request["allow_redirects"] is False
assert request["discard_cookies"] is True
assert set(request["headers"]) == {"user-agent", "accept", "content-type"}
assert result["cookies"] == []
assert result["profile"] == "chrome145"
print("OAuth worker cookie isolation and profile fallback tests passed")
