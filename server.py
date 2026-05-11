import os

import time

import threading

import urllib.request

from http.server import BaseHTTPRequestHandler, HTTPServer



# ==========================================

# 1. DEMO WEB SERVER

# ==========================================

class DemoHandler(BaseHTTPRequestHandler):

    def do_GET(self):

        self.send_response(200)

        self.send_header("Content-type", "text/html")

        self.end_headers()

        self.wfile.write(b"<html><body><h1>Demo Server is Live!</h1><p>Running successfully.</p></body></html>")



# ==========================================

# 2. RENDER KEEP-ALIVE PINGER

# ==========================================

def keep_alive_pinger():

    # ONLY RUNS ON RENDER (Railway will completely ignore this loop)

    if os.environ.get('RENDER'):

        

        # IMPORTANT: Replace this with your actual Render URL!

        RENDER_URL = "https://scanner-ai.onrender.com/"

        

        print(f"🚀 Render Keep-Alive initialized. Pinging {RENDER_URL} every 14 minutes.")

        

        while True:

            # Wait 14 minutes before pinging (Render sleeps at 15 mins)

            time.sleep(5 * 60) 

            

            try:

                # We use a standard User-Agent so Render doesn't block the ping

                req = urllib.request.Request(RENDER_URL, headers={'User-Agent': 'Mozilla/5.0'})

                with urllib.request.urlopen(req) as response:

                    print(f"🟢 [{time.strftime('%H:%M:%S')}] PING SUCCESS: Website kept alive. Status {response.status}")

            except Exception as e:

                print(f"🔴 [{time.strftime('%H:%M:%S')}] PING ERROR: {e}")



# ==========================================

# 3. START EVERYTHING

# ==========================================

if __name__ == "__main__":

    # Start the pinger loop in a background thread so it doesn't block the server

    pinger_thread = threading.Thread(target=keep_alive_pinger, daemon=True)

    pinger_thread.start()

    

    # Start the web server (Render provides a PORT environment variable, defaults to 10000)

    port = int(os.environ.get("PORT", 10000))

    server = HTTPServer(("0.0.0.0", port), DemoHandler)

    

    print(f"🌐 Demo server starting on port {port}...")

    server.serve_forever()
