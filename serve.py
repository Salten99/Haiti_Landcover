"""Local preview with HTTP Range support (the page reads the map by byte ranges, like GitHub Pages).

    python serve.py        then open http://localhost:8000
"""

import os
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start, end = int(m[1]), min(int(m[2] or size - 1), size - 1)
        if start >= size:
            self.send_error(416)
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        n = getattr(self, "_remaining", None)
        if n is None:
            return super().copyfile(source, outputfile)
        outputfile.write(source.read(n))
        self._remaining = None


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    ThreadingHTTPServer(("127.0.0.1", 8000), partial(RangeHandler, directory=here)).serve_forever()
