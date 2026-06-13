#!/usr/bin/env python3
"""
Gen Z Digital Store CRM Bug Fixes Testing Suite
Tests the 3 specific bug fixes mentioned in the review request:
1. Extension ZIP Download (in-memory generation)
2. Admin Login Verification 
3. Health Check
4. Tool API with authentication
"""

import requests
import json
import os
import sys
import zipfile
import io
from datetime import datetime

class BugFixesTester:
    def __init__(self):
        # Use the configured backend URL from frontend/.env
        self.backend_url = os.environ.get("TEST_GATEWAY_URL", "http://localhost:8001")
        self.api_base = f"{self.backend_url}/api"
        
        # Admin credentials from review request
        self.admin_email = os.environ.get("TEST_ADMIN_EMAIL")
        self.admin_password = os.environ.get("TEST_ADMIN_PASSWORD")
        # Validate required test environment variables
        if not self.admin_email or not self.admin_password:
            raise RuntimeError(
                "TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD environment variables must be set. "
                "Never hardcode credentials in test files."
            )

        
        # Test results tracking
        self.results = {
            "extension_zip": {"passed": 0, "failed": 0, "errors": []},
            "admin_login": {"passed": 0, "failed": 0, "errors": []},
            "health_check": {"passed": 0, "failed": 0, "errors": []},
            "tool_api": {"passed": 0, "failed": 0, "errors": []}
        }
        
        self.admin_token = None
        
        print(f"🚀 Gen Z Digital Store CRM Bug Fixes Tester")
        print(f"📡 Backend URL: {self.backend_url}")
        print(f"🔗 API Base: {self.api_base}")
        print(f"👤 Admin: {self.admin_email}")
        print("=" * 70)

    def log_result(self, category, test_name, success, error=None):
        """Log test result"""
        if success:
            self.results[category]["passed"] += 1
            print(f"✅ {test_name}")
        else:
            self.results[category]["failed"] += 1
            self.results[category]["errors"].append(f"{test_name}: {error}")
            print(f"❌ {test_name}: {error}")

    def make_request(self, method, url, data=None, headers=None, auth_required=False):
        """Make HTTP request with proper headers"""
        request_headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        
        if auth_required and self.admin_token:
            request_headers["Authorization"] = f"Bearer {self.admin_token}"
        
        if headers:
            request_headers.update(headers)
        
        try:
            if method.upper() == "GET":
                response = requests.get(url, headers=request_headers, timeout=30)
            elif method.upper() == "POST":
                response = requests.post(url, json=data, headers=request_headers, timeout=30)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            return response
        except requests.exceptions.RequestException as e:
            print(f"❌ Request failed: {e}")
            return None

    def test_extension_zip_download(self):
        """Test 1: Extension ZIP Download - in-memory generation"""
        print("\n📦 Testing Extension ZIP Download...")
        print("   Testing in-memory ZIP generation endpoint")
        print("   Expected: Valid ZIP file with proper headers")
        
        # Test main endpoint: GET /api/extension/download
        print("\n   Test 1.1: Main endpoint /api/extension/download")
        response = requests.get(f"{self.api_base}/extension/download", timeout=30)
        
        if response and response.status_code == 200:
            # Verify response headers
            content_type = response.headers.get("Content-Type")
            content_disposition = response.headers.get("Content-Disposition")
            cache_control = response.headers.get("Cache-Control")
            
            print(f"   Content-Type: {content_type}")
            print(f"   Content-Disposition: {content_disposition}")
            print(f"   Cache-Control: {cache_control}")
            
            # Check required headers
            headers_correct = True
            if content_type != "application/zip":
                self.log_result("extension_zip", "Content-Type header", False, f"Expected 'application/zip', got '{content_type}'")
                headers_correct = False
            else:
                self.log_result("extension_zip", "Content-Type header", True)
            
            if not content_disposition or 'filename="GenZ-Digital-Store-Access.zip"' not in content_disposition:
                self.log_result("extension_zip", "Content-Disposition header", False, f"Expected filename='GenZ-Digital-Store-Access.zip', got '{content_disposition}'")
                headers_correct = False
            else:
                self.log_result("extension_zip", "Content-Disposition header", True)
            
            if not cache_control or "no-store" not in cache_control:
                self.log_result("extension_zip", "Cache-Control header", False, f"Expected 'no-store', got '{cache_control}'")
                headers_correct = False
            else:
                self.log_result("extension_zip", "Cache-Control header", True)
            
            # Verify ZIP file is valid
            try:
                zip_content = response.content
                zip_buffer = io.BytesIO(zip_content)
                
                with zipfile.ZipFile(zip_buffer, 'r') as zip_file:
                    file_list = zip_file.namelist()
                    
                    # Check for essential extension files
                    required_files = ['manifest.json', 'popup.html']
                    required_dirs = ['js/', 'css/', 'icons/']
                    
                    print(f"   ZIP contains {len(file_list)} files:")
                    for file in file_list[:10]:  # Show first 10 files
                        print(f"     - {file}")
                    if len(file_list) > 10:
                        print(f"     ... and {len(file_list) - 10} more files")
                    
                    # Check required files
                    missing_files = []
                    for req_file in required_files:
                        if req_file not in file_list:
                            missing_files.append(req_file)
                    
                    # Check required directories (at least one file in each)
                    for req_dir in required_dirs:
                        if not any(f.startswith(req_dir) for f in file_list):
                            missing_files.append(f"{req_dir}* (directory)")
                    
                    if missing_files:
                        self.log_result("extension_zip", "ZIP file contents", False, f"Missing files: {missing_files}")
                    else:
                        self.log_result("extension_zip", "ZIP file contents", True)
                        print(f"   ✅ All required extension files present")
                
                self.log_result("extension_zip", "ZIP file validity", True)
                
            except zipfile.BadZipFile:
                self.log_result("extension_zip", "ZIP file validity", False, "Invalid ZIP file format")
            except Exception as e:
                self.log_result("extension_zip", "ZIP file validity", False, f"ZIP validation error: {e}")
        else:
            self.log_result("extension_zip", "Main endpoint response", False, f"HTTP {response.status_code if response else 'No response'}")
        
        # Test legacy endpoint: GET /chrome-extension.zip
        print("\n   Test 1.2: Legacy endpoint /chrome-extension.zip")
        response = requests.get(f"{self.backend_url}/chrome-extension.zip", timeout=30)
        
        if response and response.status_code == 200:
            content_type = response.headers.get("Content-Type")
            if content_type == "application/zip":
                self.log_result("extension_zip", "Legacy endpoint", True)
                print(f"   ✅ Legacy endpoint working, Content-Type: {content_type}")
            else:
                self.log_result("extension_zip", "Legacy endpoint", False, f"Wrong Content-Type: {content_type}")
        else:
            self.log_result("extension_zip", "Legacy endpoint", False, f"HTTP {response.status_code if response else 'No response'}")

    def test_admin_login_verification(self):
        """Test 2: Admin Login Verification"""
        print("\n👤 Testing Admin Login Verification...")
        print("   Testing POST /api/crm/auth/admin/login")
        print(f"   Email: {self.admin_email}")
        print(f"   Password: {self.admin_password}")
        
        login_data = {
            "email": self.admin_email,
            "password": self.admin_password
        }
        
        response = self.make_request("POST", f"{self.api_base}/crm/auth/admin/login", login_data, auth_required=False)
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("success") and data.get("accessToken"):
                    self.admin_token = data["accessToken"]
                    user_data = data.get("user", {})
                    
                    self.log_result("admin_login", "Admin login successful", True)
                    print(f"   ✅ Login successful")
                    print(f"   Admin ID: {user_data.get('_id', 'N/A')}")
                    print(f"   Admin Email: {user_data.get('email', 'N/A')}")
                    print(f"   Admin Role: {user_data.get('role', 'N/A')}")
                    print(f"   Admin Status: {user_data.get('status', 'N/A')}")
                    print(f"   Access Token: {self.admin_token[:20]}...")
                    
                    # Verify token format
                    if len(self.admin_token) > 50:  # JWT tokens are typically longer
                        self.log_result("admin_login", "Access token format", True)
                    else:
                        self.log_result("admin_login", "Access token format", False, f"Token seems too short: {len(self.admin_token)} chars")
                else:
                    self.log_result("admin_login", "Admin login successful", False, "Missing success or accessToken in response")
                    print(f"   Response: {json.dumps(data, indent=2)}")
            except json.JSONDecodeError:
                self.log_result("admin_login", "Admin login successful", False, "Invalid JSON response")
        else:
            error_msg = f"HTTP {response.status_code if response else 'No response'}"
            if response:
                try:
                    error_data = response.json()
                    error_msg += f" - {error_data.get('error', 'Unknown error')}"
                except:
                    error_msg += f" - {response.text[:100]}"
            
            self.log_result("admin_login", "Admin login successful", False, error_msg)

    def test_health_check(self):
        """Test 3: Health Check"""
        print("\n🏥 Testing Health Check...")
        print("   Testing GET /api/health")
        print("   Expected: Gateway and CRM backend status")
        
        response = self.make_request("GET", f"{self.api_base}/health", auth_required=False)
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                print(f"   Response: {json.dumps(data, indent=2)}")
                
                # Check gateway status
                if data.get("status") == "ok" and data.get("gateway") == "running":
                    self.log_result("health_check", "Gateway status", True)
                    print(f"   ✅ Gateway running")
                else:
                    self.log_result("health_check", "Gateway status", False, f"Gateway status: {data.get('gateway')}")
                
                # Check CRM backend status
                backend_data = data.get("backend", {})
                if backend_data.get("status") == "ok":
                    self.log_result("health_check", "CRM backend status", True)
                    print(f"   ✅ CRM backend OK")
                    
                    # Check MongoDB connection if available
                    mongodb_info = backend_data.get("mongodb", {})
                    if mongodb_info and mongodb_info.get("state") == "connected":
                        self.log_result("health_check", "MongoDB connection", True)
                        print(f"   ✅ MongoDB connected to {mongodb_info.get('database', 'N/A')}")
                    elif mongodb_info:
                        self.log_result("health_check", "MongoDB connection", False, f"MongoDB state: {mongodb_info.get('state')}")
                    else:
                        print(f"   ⚠️  No MongoDB info in health response")
                else:
                    self.log_result("health_check", "CRM backend status", False, f"Backend status: {backend_data.get('status')}")
                    if "error" in backend_data:
                        print(f"   Backend error: {backend_data['error']}")
                
            except json.JSONDecodeError:
                self.log_result("health_check", "Health check response", False, "Invalid JSON response")
        else:
            self.log_result("health_check", "Health check response", False, f"HTTP {response.status_code if response else 'No response'}")

    def test_tool_api(self):
        """Test 4: Tool API with authentication"""
        print("\n🔧 Testing Tool API...")
        print("   Testing GET /api/crm/admin/tools (with auth)")
        
        if not self.admin_token:
            self.log_result("tool_api", "Tool API test", False, "No admin token available - login must have failed")
            return
        
        print(f"   Using token: {self.admin_token[:20]}...")
        
        response = self.make_request("GET", f"{self.api_base}/crm/admin/tools", auth_required=True)
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("success") is not None:
                    tools = data.get("tools", [])
                    self.log_result("tool_api", "Tool API access", True)
                    print(f"   ✅ Tool API accessible")
                    print(f"   Tools count: {len(tools)}")
                    
                    if tools:
                        print(f"   Sample tools:")
                        for i, tool in enumerate(tools[:3]):  # Show first 3 tools
                            print(f"     {i+1}. {tool.get('name', 'N/A')} - {tool.get('category', 'N/A')}")
                    
                    # Verify response structure
                    if isinstance(tools, list):
                        self.log_result("tool_api", "Tool API response format", True)
                    else:
                        self.log_result("tool_api", "Tool API response format", False, f"Expected list, got {type(tools)}")
                else:
                    self.log_result("tool_api", "Tool API access", False, "Invalid response format - missing success field")
                    print(f"   Response: {json.dumps(data, indent=2)}")
            except json.JSONDecodeError:
                self.log_result("tool_api", "Tool API access", False, "Invalid JSON response")
        else:
            error_msg = f"HTTP {response.status_code if response else 'No response'}"
            if response:
                try:
                    error_data = response.json()
                    error_msg += f" - {error_data.get('error', 'Unknown error')}"
                except:
                    error_msg += f" - {response.text[:100]}"
            
            self.log_result("tool_api", "Tool API access", False, error_msg)

    def run_all_tests(self):
        """Run all bug fix tests"""
        print("🧪 TESTING 3 BUG FIXES FOR TOOLSTACK CRM...")
        print("Tests: Extension ZIP Download, Admin Login, Health Check, Tool API")
        
        print("\n" + "="*70)
        print("🎯 BUG FIXES TESTING SUITE")
        print("="*70)
        
        # Test 1: Extension ZIP Download
        self.test_extension_zip_download()
        
        # Test 2: Admin Login Verification  
        self.test_admin_login_verification()
        
        # Test 3: Health Check
        self.test_health_check()
        
        # Test 4: Tool API
        self.test_tool_api()
        
        # Print summary
        success = self.print_summary()
        return success

    def print_summary(self):
        """Print test results summary"""
        print("\n" + "=" * 60)
        print("📊 BUG FIXES TEST RESULTS SUMMARY")
        print("=" * 60)
        
        total_passed = 0
        total_failed = 0
        
        test_categories = {
            "extension_zip": "Extension ZIP Download",
            "admin_login": "Admin Login Verification", 
            "health_check": "Health Check",
            "tool_api": "Tool API"
        }
        
        for category, results in self.results.items():
            passed = results["passed"]
            failed = results["failed"]
            total_passed += passed
            total_failed += failed
            
            status = "✅ PASS" if failed == 0 else "❌ FAIL"
            category_name = test_categories.get(category, category.upper().replace('_', ' '))
            print(f"{category_name}: {status} ({passed} passed, {failed} failed)")
            
            if results["errors"]:
                for error in results["errors"]:
                    print(f"  ❌ {error}")
        
        print("-" * 60)
        print(f"TOTAL: {total_passed} passed, {total_failed} failed")
        
        if total_failed == 0:
            print("🎉 ALL BUG FIXES WORKING!")
            return True
        else:
            print("⚠️  SOME BUG FIXES FAILED!")
            return False

def main():
    """Main function"""
    tester = BugFixesTester()
    success = tester.run_all_tests()
    
    # Exit with appropriate code
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()