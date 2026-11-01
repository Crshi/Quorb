#!/usr/bin/env python3
"""quorb 测试服务器：静态服务 + /test/hold 延迟端点（拖住 load 事件，让异步挂载先完成）"""
import http.server
import socketserver
import time
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.startswith('/test/hold'):
            time.sleep(1.5)
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', '8')
            self.end_headers()
            self.wfile.write(b'\x89PNG\r\n\x1a\n')
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        # 本地测试服务器：禁用启发式缓存，避免改了 mock/产物后浏览器仍用旧文件
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', 8907), Handler) as httpd:
    print('serving on http://127.0.0.1:8907')
    httpd.serve_forever()
