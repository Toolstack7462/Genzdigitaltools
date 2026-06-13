from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import httpx
import os
import asyncio
import re
import subprocess
import signal
import sys
import io
import zipfile

# Global reference to CRM subprocess
crm_process = None

def start_crm_server():
    """Start the Node.js CRM server as a subprocess"""
    global crm_process
    try:
        # Check if CRM server is already running
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result = sock.connect_ex(('localhost', 8002))
        sock.close()
        
        if result == 0:
            print("✅ CRM Server already running on port 8002")
            return True
        
        # Start CRM server
        print("🚀 Starting CRM Server...")
        crm_process = subprocess.Popen(
            ['node', 'server-crm.js'],
            cwd='/app/backend',
            stdout=open('/var/log/supervisor/server-crm.out.log', 'a'),
            stderr=open('/var/log/supervisor/server-crm.err.log', 'a'),
            preexec_fn=os.setsid
        )
        
        # Wait for CRM server to be ready
        import time
        for i in range(30):  # Wait up to 30 seconds
            time.sleep(1)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            result = sock.connect_ex(('localhost', 8002))
            sock.close()
            if result == 0:
                print(f"✅ CRM Server started successfully (PID: {crm_process.pid})")
                return True
        
        print("⚠️ CRM Server failed to start within timeout")
        return False
    except Exception as e:
        print(f"❌ Failed to start CRM Server: {e}")
        return False

def stop_crm_server():
    """Stop the CRM server subprocess"""
    global crm_process
    if crm_process:
        try:
            os.killpg(os.getpgid(crm_process.pid), signal.SIGTERM)
            crm_process.wait(timeout=5)
            print("✅ CRM Server stopped")
        except Exception as e:
            print(f"⚠️ Error stopping CRM Server: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager to start/stop CRM server"""
    # Startup
    start_crm_server()
    yield
    # Shutdown
    stop_crm_server()

app = FastAPI(title="Gen Z Digital Store API Gateway", lifespan=lifespan)

# ============================================================================
# CORS CONFIGURATION — explicit allowlist from environment variable
# ============================================================================
# Set ALLOWED_ORIGINS in your .env as a comma-separated list:
#   ALLOWED_ORIGINS=https://app.example.com,http://localhost:3000
_raw_allowed_origins = os.getenv("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS_SET: set = set(
    o.strip() for o in _raw_allowed_origins.split(",") if o.strip()
)

if not ALLOWED_ORIGINS_SET:
    print("⚠️  WARNING: ALLOWED_ORIGINS env var is not set. No browser origins permitted.")

def is_origin_allowed(origin: str) -> bool:
    """Check if origin is in explicit allowlist"""
    if not origin:
        return True  # Allow server-to-server (no Origin header)

    if origin in ALLOWED_ORIGINS_SET:
        print(f"✅ CORS: Allowed origin: {origin}")
        return True

    print(f"⚠️  CORS: Blocked origin: {origin}")
    return False

# Dynamic CORS middleware
@app.middleware("http")
async def dynamic_cors_middleware(request: Request, call_next):
    origin = request.headers.get("origin")
    
    response = await call_next(request)
    
    if origin and is_origin_allowed(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        # FIX13: Explicit methods/headers — wildcard+credentials is blocked by browsers
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Extension-Version, X-Requested-With"
    
    return response

# Handle preflight requests
@app.options("/{path:path}")
async def options_handler(request: Request, path: str):
    origin = request.headers.get("origin")
    
    if origin and is_origin_allowed(origin):
        return Response(
            status_code=200,
            headers={
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": "*"
            }
        )
    return Response(status_code=403)

# CRM Backend URL
CRM_BACKEND_URL = os.getenv("CRM_BACKEND_URL", "http://localhost:8002")

print("\n" + "="*70)
print("🚀 TOOLSTACK API GATEWAY - STARTUP")
print("="*70)
print(f"CRM Backend: {CRM_BACKEND_URL}")
print(f"Environment: {os.getenv('NODE_ENV', 'development')}")
print("="*70 + "\n")

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "service": "Gen Z Digital Store API Gateway",
        "crm_backend": CRM_BACKEND_URL
    }

@app.get("/api/health")
async def api_health():
    """API health check with backend status"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{CRM_BACKEND_URL}/api/crm/health", timeout=5.0)
            backend_status = response.json() if response.status_code == 200 else {"error": "Backend unreachable"}
    except Exception as e:
        backend_status = {"error": str(e)}
    
    return {
        "status": "ok",
        "gateway": "running",
        "backend": backend_status
    }

# ============================================================================
# CHROME EXTENSION ZIP DOWNLOAD - IN-MEMORY GENERATION
# ============================================================================
def create_extension_zip():
    """Generate Chrome Extension ZIP file in-memory"""
    extension_dir = "/app/chrome-extension"
    
    # Create in-memory ZIP
    zip_buffer = io.BytesIO()
    
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(extension_dir):
            # Skip hidden directories and __pycache__
            dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
            
            for file in files:
                # Skip hidden files and temp files
                if file.startswith('.') or file.endswith('.pyc'):
                    continue
                    
                file_path = os.path.join(root, file)
                # Calculate archive path relative to extension_dir
                arcname = os.path.relpath(file_path, extension_dir)
                zip_file.write(file_path, arcname)
    
    zip_buffer.seek(0)
    return zip_buffer.getvalue()

@app.get("/api/extension/download")
async def download_extension():
    """Download Chrome Extension as ZIP file - in-memory generation"""
    try:
        zip_content = create_extension_zip()
        
        return Response(
            content=zip_content,
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="GenZ-Digital-Store-Access.zip"',
                "Content-Type": "application/zip",
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
                "Content-Length": str(len(zip_content))
            }
        )
    except Exception as e:
        print(f"❌ Extension ZIP generation error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": f"Failed to generate extension ZIP: {str(e)}"}
        )

# Also serve on the old path for backward compatibility
@app.get("/chrome-extension.zip")
async def download_extension_legacy():
    """Legacy path for extension download"""
    return await download_extension()

@app.api_route("/api/crm/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_to_crm(path: str, request: Request):
    """Proxy all /api/crm/* requests to Node CRM backend"""
    try:
        # Get request details
        method = request.method
        headers = dict(request.headers)
        
        # Remove host header to avoid conflicts
        headers.pop("host", None)
        
        # Get body if present
        body = await request.body()
        
        # Forward request to CRM backend
        url = f"{CRM_BACKEND_URL}/api/crm/{path}"
        
        async with httpx.AsyncClient() as client:
            response = await client.request(
                method=method,
                url=url,
                headers=headers,
                content=body,
                params=request.query_params,
                timeout=30.0
            )
            
            # Return response
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.headers.get("content-type")
            )
    except httpx.TimeoutException:
        return JSONResponse(
            status_code=504,
            content={"error": "Backend timeout"}
        )
    except Exception as e:
        return JSONResponse(
            status_code=502,
            content={"error": f"Proxy error: {str(e)}"}
        )

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8001))
    uvicorn.run(app, host="0.0.0.0", port=port)
