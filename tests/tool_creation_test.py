#!/usr/bin/env python3
"""
Tool Creation Validation Fix Test - CRITICAL PRIORITY
Testing the specific scenarios from the review request
"""

import os
import requests
import json
import sys

class ToolCreationTester:
    def __init__(self):
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

        self.admin_token = None
        
        # Results tracking
        self.results = {"passed": 0, "failed": 0, "errors": []}
        
        print("🔧 Tool Creation Validation Fix Test - CRITICAL PRIORITY")
        print("=" * 60)

    def log_result(self, test_name, success, error=None):
        """Log test result"""
        if success:
            self.results["passed"] += 1
            print(f"✅ {test_name}")
        else:
            self.results["failed"] += 1
            self.results["errors"].append(f"{test_name}: {error}")
            print(f"❌ {test_name}: {error}")

    def make_request(self, method, endpoint, data=None, auth_required=True):
        """Make HTTP request"""
        url = f"{self.api_base}{endpoint}"
        
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        
        if auth_required and self.admin_token:
            headers["Authorization"] = f"Bearer {self.admin_token}"
        
        try:
            if method.upper() == "POST":
                response = requests.post(url, json=data, headers=headers, timeout=30)
            elif method.upper() == "GET":
                response = requests.get(url, headers=headers, timeout=30)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            return response
        except requests.exceptions.RequestException as e:
            print(f"❌ Request failed: {e}")
            return None

    def login_admin(self):
        """Login as admin to get token"""
        print("\n🔐 Logging in as admin...")
        
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
                    self.log_result("Admin login", True)
                    print(f"   Admin ID: {data.get('user', {}).get('_id', 'N/A')}")
                    return True
                else:
                    self.log_result("Admin login", False, "Missing success or accessToken")
                    return False
            except json.JSONDecodeError:
                self.log_result("Admin login", False, "Invalid JSON response")
                return False
        else:
            self.log_result("Admin login", False, f"HTTP {response.status_code if response else 'No response'}")
            return False

    def test_tool_creation_scenarios(self):
        """Test the 5 specific tool creation scenarios from review request"""
        print("\n🔧 Testing Tool Creation Validation Fix - 5 CRITICAL SCENARIOS")
        print("Backend endpoint: POST /api/crm/admin/tools")
        print("Validation schema: name (required), targetUrl (required, valid URI), category (from specific list)")
        
        # Test scenarios EXACTLY as specified in review request
        test_scenarios = [
            {
                "name": "1. TOOL CREATION - COMPLETE FIELDS (Priority: CRITICAL)",
                "data": {
                    "name": "Test Tool Complete",
                    "description": "Testing with all fields",
                    "targetUrl": "https://testtool.com",
                    "category": "AI",
                    "cookiesEncrypted": "session=abc123",
                    "status": "active"
                },
                "expected_status": 201,
                "expected_result": "201 Created, tool created successfully"
            },
            {
                "name": "2. TOOL CREATION - MINIMAL FIELDS (Priority: HIGH)",
                "data": {
                    "name": "Minimal Test Tool",
                    "targetUrl": "https://minimal.com",
                    "category": "Other"
                },
                "expected_status": 201,
                "expected_result": "201 Created (description and cookiesEncrypted are optional)"
            },
            {
                "name": "3. TOOL CREATION - MISSING REQUIRED FIELD (Priority: HIGH)",
                "data": {
                    "name": "No URL Tool"
                },
                "expected_status": 400,
                "expected_result": "400 Bad Request with validation error about targetUrl"
            },
            {
                "name": "4. TOOL CREATION - INVALID URL (Priority: MEDIUM)",
                "data": {
                    "name": "Invalid URL Tool",
                    "targetUrl": "not-a-valid-url"
                },
                "expected_status": 400,
                "expected_result": "400 Bad Request with URL validation error"
            },
            {
                "name": "5. TOOL CREATION - INVALID CATEGORY (Priority: MEDIUM)",
                "data": {
                    "name": "Invalid Category Tool",
                    "targetUrl": "https://test.com",
                    "category": "InvalidCategory"
                },
                "expected_status": 400,
                "expected_result": "400 Bad Request with category validation error"
            }
        ]
        
        created_tool_ids = []
        
        for i, scenario in enumerate(test_scenarios, 1):
            print(f"\n--- Test {i}/5: {scenario['name']} ---")
            print(f"Data: {json.dumps(scenario['data'], indent=2)}")
            print(f"Expected Status: {scenario['expected_status']}")
            print(f"Expected Result: {scenario['expected_result']}")
            
            response = self.make_request("POST", "/admin/tools", scenario['data'])
            
            if response:
                print(f"Actual Status: {response.status_code}")
                
                if response.status_code == scenario['expected_status']:
                    try:
                        data = response.json()
                        print(f"Response: {json.dumps(data, indent=2)}")
                        
                        if scenario['expected_status'] == 201:
                            # Success case - should have tool created
                            if data.get("success") and data.get("tool") and data.get("tool", {}).get("_id"):
                                tool_id = data["tool"]["_id"]
                                created_tool_ids.append(tool_id)
                                
                                self.log_result(f"Test {i}: {scenario['name']}", True)
                                print(f"✅ SUCCESS: Tool created with ID {tool_id}")
                                print(f"   Tool Name: {data['tool'].get('name', 'N/A')}")
                                print(f"   Tool Category: {data['tool'].get('category', 'N/A')}")
                                print(f"   Tool URL: {data['tool'].get('targetUrl', 'N/A')}")
                                print(f"   Tool Status: {data['tool'].get('status', 'N/A')}")
                            else:
                                self.log_result(f"Test {i}: {scenario['name']}", False, "Missing success, tool, or tool._id in response")
                        else:
                            # Error case - should have proper error message
                            if "error" in data:
                                self.log_result(f"Test {i}: {scenario['name']}", True)
                                print(f"✅ SUCCESS: Proper validation error returned")
                                print(f"   Error: {data.get('error')}")
                                if 'details' in data:
                                    print(f"   Details: {data['details']}")
                            else:
                                self.log_result(f"Test {i}: {scenario['name']}", False, "No error message in response")
                                
                    except json.JSONDecodeError as e:
                        self.log_result(f"Test {i}: {scenario['name']}", False, f"Invalid JSON response: {e}")
                else:
                    # Status code mismatch
                    try:
                        error_data = response.json()
                        error_msg = f"Expected {scenario['expected_status']}, got {response.status_code} - {error_data.get('error', 'Unknown error')}"
                        if 'details' in error_data:
                            error_msg += f" - Details: {error_data['details']}"
                    except:
                        error_msg = f"Expected {scenario['expected_status']}, got {response.status_code} - {response.text[:200]}"
                    
                    self.log_result(f"Test {i}: {scenario['name']}", False, error_msg)
            else:
                self.log_result(f"Test {i}: {scenario['name']}", False, "No response from server")
        
        # Verify created tools exist in database
        if created_tool_ids:
            print(f"\n🔍 Verifying {len(created_tool_ids)} created tools exist in database...")
            response = self.make_request("GET", "/admin/tools")
            
            if response and response.status_code == 200:
                try:
                    data = response.json()
                    if data.get("success") and "tools" in data:
                        tools_in_db = data["tools"]
                        found_tools = [tool for tool in tools_in_db if tool.get("_id") in created_tool_ids]
                        
                        if len(found_tools) == len(created_tool_ids):
                            self.log_result("Database persistence verification", True)
                            print(f"✅ All {len(found_tools)} created tools found in database")
                            for tool in found_tools:
                                print(f"   - {tool.get('name')} (ID: {tool.get('_id')})")
                        else:
                            self.log_result("Database persistence verification", False, f"Expected {len(created_tool_ids)} tools, found {len(found_tools)}")
                    else:
                        self.log_result("Database persistence verification", False, "Invalid response format")
                except json.JSONDecodeError:
                    self.log_result("Database persistence verification", False, "Invalid JSON response")
            else:
                self.log_result("Database persistence verification", False, f"HTTP {response.status_code if response else 'No response'}")

    def run_tests(self):
        """Run all tests"""
        if not self.login_admin():
            print("❌ Cannot proceed without admin login")
            return False
        
        self.test_tool_creation_scenarios()
        
        # Print summary
        print("\n" + "=" * 60)
        print("📊 TEST RESULTS SUMMARY")
        print("=" * 60)
        
        print(f"PASSED: {self.results['passed']}")
        print(f"FAILED: {self.results['failed']}")
        
        if self.results["errors"]:
            print("\nERRORS:")
            for error in self.results["errors"]:
                print(f"  ❌ {error}")
        
        if self.results["failed"] == 0:
            print("\n🎉 ALL TESTS PASSED!")
            return True
        else:
            print("\n⚠️  SOME TESTS FAILED!")
            return False

def main():
    """Main function"""
    tester = ToolCreationTester()
    success = tester.run_tests()
    
    # Exit with appropriate code
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()