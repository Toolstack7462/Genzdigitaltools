#!/usr/bin/env python3
"""
Gen Z Digital Store CRM Backend API Testing Suite - Unified Credential System Enhancement
Tests the new unified credential schema with form, SSO, and headers credential types
"""

import requests
import json
import os
import sys
from datetime import datetime
import uuid

class UnifiedCredentialTester:
    def __init__(self):
        # Use environment URL for testing
        self.gateway_url = os.environ.get("TEST_GATEWAY_URL", "http://localhost:8001")
        self.api_base = f"{self.gateway_url}/api/crm"
        
        # Admin credentials from review request
        self.admin_email = os.environ.get("TEST_ADMIN_EMAIL")
        self.admin_password = os.environ.get("TEST_ADMIN_PASSWORD")
        # Validate required test environment variables
        if not self.admin_email or not self.admin_password:
            raise RuntimeError(
                "TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD environment variables must be set. "
                "Never hardcode credentials in test files."
            )

        
        # Test data
        self.admin_token = None
        self.created_tool_ids = []
        
        # Results tracking
        self.results = {
            "health_check": {"passed": 0, "failed": 0, "errors": []},
            "admin_login": {"passed": 0, "failed": 0, "errors": []},
            "tool_creation": {"passed": 0, "failed": 0, "errors": []},
            "tool_retrieval": {"passed": 0, "failed": 0, "errors": []},
            "tool_update": {"passed": 0, "failed": 0, "errors": []}
        }
        
        print(f"🚀 Gen Z Digital Store CRM Unified Credential System Tester")
        print(f"📡 Gateway URL: {self.gateway_url}")
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

    def make_request(self, method, endpoint, data=None, headers=None, auth_required=True):
        """Make HTTP request with proper headers"""
        if endpoint.startswith("http"):
            url = endpoint
        else:
            url = f"{self.api_base}{endpoint}"
        
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
            elif method.upper() == "PUT":
                response = requests.put(url, json=data, headers=request_headers, timeout=30)
            elif method.upper() == "DELETE":
                response = requests.delete(url, headers=request_headers, timeout=30)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            return response
        except requests.exceptions.RequestException as e:
            print(f"❌ Request failed: {e}")
            return None

    def test_health_check(self):
        """Test health check endpoint"""
        print("\n🏥 Testing Health Check...")
        
        response = self.make_request("GET", "/health", auth_required=False)
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("status") == "ok":
                    self.log_result("health_check", "CRM Backend health check", True)
                    print(f"   Service: {data.get('service', 'Unknown')}")
                    print(f"   Version: {data.get('version', 'Unknown')}")
                    
                    # Check MongoDB connection
                    mongodb_info = data.get("mongodb", {})
                    if mongodb_info.get("state") == "connected":
                        self.log_result("health_check", "MongoDB connection verified", True)
                        print(f"   MongoDB: {mongodb_info.get('host')}/{mongodb_info.get('database')}")
                    else:
                        self.log_result("health_check", "MongoDB connection verified", False, f"State: {mongodb_info.get('state')}")
                else:
                    self.log_result("health_check", "CRM Backend health check", False, "Status not OK")
            except json.JSONDecodeError:
                self.log_result("health_check", "CRM Backend health check", False, "Invalid JSON response")
        else:
            self.log_result("health_check", "CRM Backend health check", False, f"HTTP {response.status_code if response else 'No response'}")

    def test_admin_login(self):
        """Test admin login with existing credentials"""
        print("\n👤 Testing Admin Login...")
        
        login_data = {
            "email": self.admin_email,
            "password": self.admin_password
        }
        
        response = self.make_request("POST", "/auth/admin/login", login_data, auth_required=False)
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("success") and data.get("accessToken"):
                    self.admin_token = data["accessToken"]
                    user_data = data.get("user", {})
                    
                    self.log_result("admin_login", "Admin login successful", True)
                    print(f"   Admin ID: {user_data.get('_id', 'N/A')}")
                    print(f"   Admin Email: {user_data.get('email', 'N/A')}")
                    print(f"   Admin Role: {user_data.get('role', 'N/A')}")
                    print(f"   Token received: {self.admin_token[:20]}...")
                else:
                    self.log_result("admin_login", "Admin login successful", False, "Missing success or accessToken in response")
            except json.JSONDecodeError:
                self.log_result("admin_login", "Admin login successful", False, "Invalid JSON response")
        else:
            self.log_result("admin_login", "Admin login successful", False, f"HTTP {response.status_code if response else 'No response'}")

    def test_tool_creation_unified_credentials(self):
        """Test tool creation with unified credential schema"""
        print("\n🔧 Testing Tool Creation with Unified Credentials...")
        
        if not self.admin_token:
            self.log_result("tool_creation", "Tool creation tests", False, "No admin token available")
            return
        
        # Test A - Form Login Credential Type
        print("\n   Test A: Form Login Credential Type")
        form_tool_data = {
            "name": "Test Form Login Tool",
            "targetUrl": "https://app.example.com/dashboard",
            "loginUrl": "https://app.example.com/login",
            "category": "Productivity",
            "credentialType": "form",
            "credentials": {
                "type": "form",
                "payload": {
                    "username": "testuser",
                    "password": "testpass123"
                },
                "selectors": {
                    "username": "input[name='email']",
                    "password": "input[type='password']",
                    "submit": "button[type='submit']"
                },
                "successCheck": {
                    "urlIncludes": "/dashboard",
                    "urlExcludes": "/login"
                }
            },
            "extensionSettings": {
                "reloadAfterLogin": True,
                "spaMode": True,
                "retryAttempts": 3
            }
        }
        
        response = self.make_request("POST", "/admin/tools", form_tool_data)
        
        if response and response.status_code == 201:
            try:
                data = response.json()
                if data.get("success") and data.get("tool") and data.get("tool", {}).get("_id"):
                    tool_id = data["tool"]["_id"]
                    self.created_tool_ids.append(tool_id)
                    
                    self.log_result("tool_creation", "Test A: Form Login Tool Creation", True)
                    print(f"   ✅ Tool created with ID: {tool_id}")
                    print(f"   Name: {data['tool'].get('name')}")
                    print(f"   Credential Type: {data['tool'].get('credentialType')}")
                    print(f"   Login URL: {data['tool'].get('loginUrl')}")
                    
                    # Verify unified credentials structure
                    credentials = data['tool'].get('credentials', {})
                    if credentials.get('type') == 'form':
                        self.log_result("tool_creation", "Test A: Unified credentials structure", True)
                        print(f"   ✅ Unified credentials type: {credentials.get('type')}")
                    else:
                        self.log_result("tool_creation", "Test A: Unified credentials structure", False, f"Expected 'form', got '{credentials.get('type')}'")
                else:
                    self.log_result("tool_creation", "Test A: Form Login Tool Creation", False, "Missing required fields in response")
            except json.JSONDecodeError:
                self.log_result("tool_creation", "Test A: Form Login Tool Creation", False, "Invalid JSON response")
        else:
            error_msg = f"HTTP {response.status_code if response else 'No response'}"
            if response:
                try:
                    error_data = response.json()
                    error_msg += f" - {error_data.get('error', 'Unknown error')}"
                except:
                    error_msg += f" - {response.text[:200]}"
            self.log_result("tool_creation", "Test A: Form Login Tool Creation", False, error_msg)
        
        # Test B - SSO Credential Type
        print("\n   Test B: SSO Credential Type")
        sso_tool_data = {
            "name": "Test SSO Tool",
            "targetUrl": "https://ssoapp.example.com",
            "category": "AI",
            "credentialType": "sso",
            "credentials": {
                "type": "sso",
                "payload": {
                    "authStartUrl": "https://ssoapp.example.com/auth/google",
                    "postLoginUrl": "https://ssoapp.example.com/dashboard",
                    "provider": "google",
                    "autoClick": True
                },
                "successCheck": {
                    "urlIncludes": "/dashboard",
                    "elementExists": ".user-avatar"
                }
            }
        }
        
        response = self.make_request("POST", "/admin/tools", sso_tool_data)
        
        if response and response.status_code == 201:
            try:
                data = response.json()
                if data.get("success") and data.get("tool") and data.get("tool", {}).get("_id"):
                    tool_id = data["tool"]["_id"]
                    self.created_tool_ids.append(tool_id)
                    
                    self.log_result("tool_creation", "Test B: SSO Tool Creation", True)
                    print(f"   ✅ Tool created with ID: {tool_id}")
                    print(f"   Name: {data['tool'].get('name')}")
                    print(f"   Credential Type: {data['tool'].get('credentialType')}")
                    
                    # Verify unified credentials structure
                    credentials = data['tool'].get('credentials', {})
                    if credentials.get('type') == 'sso':
                        self.log_result("tool_creation", "Test B: Unified credentials structure", True)
                        print(f"   ✅ Unified credentials type: {credentials.get('type')}")
                    else:
                        self.log_result("tool_creation", "Test B: Unified credentials structure", False, f"Expected 'sso', got '{credentials.get('type')}'")
                else:
                    self.log_result("tool_creation", "Test B: SSO Tool Creation", False, "Missing required fields in response")
            except json.JSONDecodeError:
                self.log_result("tool_creation", "Test B: SSO Tool Creation", False, "Invalid JSON response")
        else:
            error_msg = f"HTTP {response.status_code if response else 'No response'}"
            if response:
                try:
                    error_data = response.json()
                    error_msg += f" - {error_data.get('error', 'Unknown error')}"
                except:
                    error_msg += f" - {response.text[:200]}"
            self.log_result("tool_creation", "Test B: SSO Tool Creation", False, error_msg)
        
        # Test C - Headers Credential Type
        print("\n   Test C: Headers Credential Type")
        headers_tool_data = {
            "name": "Test Headers Tool",
            "targetUrl": "https://api.example.com",
            "category": "SEO",
            "credentialType": "headers",
            "credentials": {
                "type": "headers",
                "payload": {
                    "headers": [
                        {"name": "Authorization", "value": "test-token-123", "prefix": "Bearer "},
                        {"name": "X-API-Key", "value": "api-key-456"}
                    ]
                }
            }
        }
        
        response = self.make_request("POST", "/admin/tools", headers_tool_data)
        
        if response and response.status_code == 201:
            try:
                data = response.json()
                if data.get("success") and data.get("tool") and data.get("tool", {}).get("_id"):
                    tool_id = data["tool"]["_id"]
                    self.created_tool_ids.append(tool_id)
                    
                    self.log_result("tool_creation", "Test C: Headers Tool Creation", True)
                    print(f"   ✅ Tool created with ID: {tool_id}")
                    print(f"   Name: {data['tool'].get('name')}")
                    print(f"   Credential Type: {data['tool'].get('credentialType')}")
                    
                    # Verify unified credentials structure
                    credentials = data['tool'].get('credentials', {})
                    if credentials.get('type') == 'headers':
                        self.log_result("tool_creation", "Test C: Unified credentials structure", True)
                        print(f"   ✅ Unified credentials type: {credentials.get('type')}")
                    else:
                        self.log_result("tool_creation", "Test C: Unified credentials structure", False, f"Expected 'headers', got '{credentials.get('type')}'")
                else:
                    self.log_result("tool_creation", "Test C: Headers Tool Creation", False, "Missing required fields in response")
            except json.JSONDecodeError:
                self.log_result("tool_creation", "Test C: Headers Tool Creation", False, "Invalid JSON response")
        else:
            error_msg = f"HTTP {response.status_code if response else 'No response'}"
            if response:
                try:
                    error_data = response.json()
                    error_msg += f" - {error_data.get('error', 'Unknown error')}"
                except:
                    error_msg += f" - {response.text[:200]}"
            self.log_result("tool_creation", "Test C: Headers Tool Creation", False, error_msg)

    def test_tool_retrieval(self):
        """Test tool retrieval endpoints"""
        print("\n📋 Testing Tool Retrieval...")
        
        if not self.admin_token:
            self.log_result("tool_retrieval", "Tool retrieval tests", False, "No admin token available")
            return
        
        # Test GET /api/crm/admin/tools - List all tools
        print("\n   Testing GET /api/crm/admin/tools")
        response = self.make_request("GET", "/admin/tools")
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("success") and "tools" in data:
                    tools = data["tools"]
                    self.log_result("tool_retrieval", "List all tools", True)
                    print(f"   ✅ Retrieved {len(tools)} tools")
                    
                    # Verify created tools are in the list
                    found_tools = [tool for tool in tools if tool.get("_id") in self.created_tool_ids]
                    if len(found_tools) == len(self.created_tool_ids):
                        self.log_result("tool_retrieval", "Created tools in list", True)
                        print(f"   ✅ All {len(found_tools)} created tools found in list")
                        
                        # Verify unified credentials structure in list
                        for tool in found_tools:
                            credentials = tool.get("credentials", {})
                            if credentials.get("type") in ["form", "sso", "headers"]:
                                print(f"   ✅ Tool '{tool.get('name')}' has unified credentials type: {credentials.get('type')}")
                            else:
                                print(f"   ⚠️  Tool '{tool.get('name')}' missing unified credentials")
                    else:
                        self.log_result("tool_retrieval", "Created tools in list", False, f"Expected {len(self.created_tool_ids)}, found {len(found_tools)}")
                else:
                    self.log_result("tool_retrieval", "List all tools", False, "Invalid response format")
            except json.JSONDecodeError:
                self.log_result("tool_retrieval", "List all tools", False, "Invalid JSON response")
        else:
            self.log_result("tool_retrieval", "List all tools", False, f"HTTP {response.status_code if response else 'No response'}")
        
        # Test GET /api/crm/admin/tools/:id - Get individual tools
        for i, tool_id in enumerate(self.created_tool_ids):
            print(f"\n   Testing GET /api/crm/admin/tools/{tool_id}")
            response = self.make_request("GET", f"/admin/tools/{tool_id}")
            
            if response and response.status_code == 200:
                try:
                    data = response.json()
                    if data.get("success") and data.get("tool"):
                        tool = data["tool"]
                        self.log_result("tool_retrieval", f"Get tool {i+1} details", True)
                        print(f"   ✅ Tool details retrieved: {tool.get('name')}")
                        
                        # Verify unified credentials structure
                        credentials = tool.get("credentials", {})
                        if credentials and credentials.get("type"):
                            self.log_result("tool_retrieval", f"Tool {i+1} unified credentials", True)
                            print(f"   ✅ Unified credentials type: {credentials.get('type')}")
                            print(f"   ✅ Has selectors: {'selectors' in credentials}")
                            print(f"   ✅ Has successCheck: {'successCheck' in credentials}")
                        else:
                            self.log_result("tool_retrieval", f"Tool {i+1} unified credentials", False, "Missing unified credentials")
                    else:
                        self.log_result("tool_retrieval", f"Get tool {i+1} details", False, "Invalid response format")
                except json.JSONDecodeError:
                    self.log_result("tool_retrieval", f"Get tool {i+1} details", False, "Invalid JSON response")
            else:
                self.log_result("tool_retrieval", f"Get tool {i+1} details", False, f"HTTP {response.status_code if response else 'No response'}")

    def test_tool_update(self):
        """Test tool update with credential type change"""
        print("\n🔄 Testing Tool Update...")
        
        if not self.admin_token or not self.created_tool_ids:
            self.log_result("tool_update", "Tool update tests", False, "No admin token or created tools available")
            return
        
        # Update the first created tool (form login) to change credential type
        tool_id = self.created_tool_ids[0]
        print(f"\n   Testing PUT /api/crm/admin/tools/{tool_id}")
        
        update_data = {
            "name": "Updated Form Login Tool",
            "description": "Updated description for form login tool",
            "credentialType": "sso",  # Change from form to sso
            "credentials": {
                "type": "sso",
                "payload": {
                    "authStartUrl": "https://updated.example.com/auth/google",
                    "postLoginUrl": "https://updated.example.com/dashboard",
                    "provider": "google",
                    "autoClick": True
                },
                "successCheck": {
                    "urlIncludes": "/dashboard",
                    "elementExists": ".user-profile"
                }
            },
            "extensionSettings": {
                "reloadAfterLogin": False,
                "spaMode": True,
                "retryAttempts": 5,
                "retryDelayMs": 2000
            }
        }
        
        response = self.make_request("PUT", f"/admin/tools/{tool_id}", update_data)
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("success") and data.get("tool"):
                    tool = data["tool"]
                    self.log_result("tool_update", "Tool update successful", True)
                    print(f"   ✅ Tool updated: {tool.get('name')}")
                    print(f"   ✅ New credential type: {tool.get('credentialType')}")
                    
                    # Verify credential type change
                    if tool.get("credentialType") == "sso":
                        self.log_result("tool_update", "Credential type change", True)
                        print(f"   ✅ Credential type successfully changed to SSO")
                    else:
                        self.log_result("tool_update", "Credential type change", False, f"Expected 'sso', got '{tool.get('credentialType')}'")
                    
                    # Verify unified credentials structure
                    credentials = tool.get("credentials", {})
                    if credentials.get("type") == "sso":
                        self.log_result("tool_update", "Updated unified credentials", True)
                        print(f"   ✅ Unified credentials updated to type: {credentials.get('type')}")
                    else:
                        self.log_result("tool_update", "Updated unified credentials", False, f"Expected 'sso', got '{credentials.get('type')}'")
                    
                    # Verify extension settings update
                    ext_settings = tool.get("extensionSettings", {})
                    if ext_settings.get("retryAttempts") == 5:
                        self.log_result("tool_update", "Extension settings update", True)
                        print(f"   ✅ Extension settings updated: retryAttempts = {ext_settings.get('retryAttempts')}")
                    else:
                        self.log_result("tool_update", "Extension settings update", False, f"Expected retryAttempts=5, got {ext_settings.get('retryAttempts')}")
                else:
                    self.log_result("tool_update", "Tool update successful", False, "Invalid response format")
            except json.JSONDecodeError:
                self.log_result("tool_update", "Tool update successful", False, "Invalid JSON response")
        else:
            error_msg = f"HTTP {response.status_code if response else 'No response'}"
            if response:
                try:
                    error_data = response.json()
                    error_msg += f" - {error_data.get('error', 'Unknown error')}"
                except:
                    error_msg += f" - {response.text[:200]}"
            self.log_result("tool_update", "Tool update successful", False, error_msg)

    def run_all_tests(self):
        """Run all unified credential system tests"""
        print("🧪 UNIFIED CREDENTIAL SYSTEM TESTING...")
        print("Context: Testing new unified credential schema with form, SSO, and headers types")
        print("Priority: Tool Creation (CRITICAL), Tool Retrieval, Tool Update, Admin Login, Health Check")
        
        print("\n" + "="*70)
        print("🎯 UNIFIED CREDENTIAL SYSTEM TEST SUITE")
        print("="*70)
        
        # 1. Health check
        self.test_health_check()
        
        # 2. Admin login
        self.test_admin_login()
        
        # 3. Tool creation with unified credentials (CRITICAL)
        self.test_tool_creation_unified_credentials()
        
        # 4. Tool retrieval
        self.test_tool_retrieval()
        
        # 5. Tool update
        self.test_tool_update()
        
        # Print summary
        success = self.print_summary()
        return success

    def print_summary(self):
        """Print test results summary"""
        print("\n" + "=" * 60)
        print("📊 UNIFIED CREDENTIAL SYSTEM TEST RESULTS")
        print("=" * 60)
        
        total_passed = 0
        total_failed = 0
        
        for category, results in self.results.items():
            passed = results["passed"]
            failed = results["failed"]
            total_passed += passed
            total_failed += failed
            
            status = "✅ PASS" if failed == 0 else "❌ FAIL"
            print(f"{category.upper().replace('_', ' ')}: {status} ({passed} passed, {failed} failed)")
            
            if results["errors"]:
                for error in results["errors"]:
                    print(f"  ❌ {error}")
        
        print("-" * 60)
        print(f"TOTAL: {total_passed} passed, {total_failed} failed")
        
        if total_failed == 0:
            print("🎉 ALL UNIFIED CREDENTIAL TESTS PASSED!")
            print("\n📋 CREATED TOOLS FOR TESTING:")
            for i, tool_id in enumerate(self.created_tool_ids, 1):
                print(f"  {i}. Tool ID: {tool_id}")
            return True
        else:
            print("⚠️  SOME UNIFIED CREDENTIAL TESTS FAILED!")
            return False

def main():
    """Main function"""
    tester = UnifiedCredentialTester()
    success = tester.run_all_tests()
    
    # Exit with appropriate code
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()