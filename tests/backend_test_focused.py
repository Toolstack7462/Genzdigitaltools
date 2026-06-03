#!/usr/bin/env python3
"""
Environment-Agnostic API Configuration Testing
Tests the specific requirements from the review request:
1. Health Check: /api/health and /api/crm/health
2. CORS Headers: Access-Control-Allow-Origin, Access-Control-Allow-Credentials
3. API Gateway Proxy: /api/crm/* routes properly proxied
"""

import requests
import json
import os
import sys
from datetime import datetime

class EnvironmentAgnosticTester:
    def __init__(self):
        # Use preview URL from frontend .env for environment-agnostic testing
        self.gateway_url = os.environ.get("TEST_GATEWAY_URL", "http://localhost:8001")
        
        # Test endpoints as specified in review request
        self.health_endpoint = f"{self.gateway_url}/api/health"
        self.crm_health_endpoint = f"{self.gateway_url}/api/crm/health"
        
        # Results tracking
        self.results = {
            "health_checks": {"passed": 0, "failed": 0, "errors": []},
            "cors_headers": {"passed": 0, "failed": 0, "errors": []},
            "api_gateway_proxy": {"passed": 0, "failed": 0, "errors": []}
        }
        
        print(f"🚀 Environment-Agnostic API Configuration Testing")
        print(f"📡 Gateway URL: {self.gateway_url}")
        print(f"🎯 Testing: Health checks, CORS headers, API gateway proxy")
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

    def make_request_with_origin(self, url, origin=None):
        """Make request with optional origin header for CORS testing"""
        headers = {
            "Accept": "application/json",
            "User-Agent": "EnvironmentAgnosticTester/1.0"
        }
        
        if origin:
            headers["Origin"] = origin
        
        try:
            response = requests.get(url, headers=headers, timeout=30)
            return response
        except requests.exceptions.RequestException as e:
            print(f"❌ Request failed: {e}")
            return None

    def test_health_checks(self):
        """Test health check endpoints as specified in review request"""
        print("\n🏥 Testing Health Check Endpoints...")
        
        # Test 1: /api/health endpoint
        print(f"\n   Testing: GET {self.health_endpoint}")
        response = self.make_request_with_origin(self.health_endpoint)
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("status") == "ok" and "gateway" in data:
                    self.log_result("health_checks", "/api/health endpoint", True)
                    print(f"   Gateway Status: {data.get('gateway', 'Unknown')}")
                    
                    # Check if backend info is included
                    backend_info = data.get("backend", {})
                    if backend_info:
                        print(f"   Backend Status: {backend_info.get('status', 'Unknown')}")
                else:
                    self.log_result("health_checks", "/api/health endpoint", False, "Missing required fields in response")
            except json.JSONDecodeError:
                self.log_result("health_checks", "/api/health endpoint", False, "Invalid JSON response")
        else:
            self.log_result("health_checks", "/api/health endpoint", False, f"HTTP {response.status_code if response else 'No response'}")
        
        # Test 2: /api/crm/health endpoint (proxied through gateway)
        print(f"\n   Testing: GET {self.crm_health_endpoint}")
        response = self.make_request_with_origin(self.crm_health_endpoint)
        
        if response and response.status_code == 200:
            try:
                data = response.json()
                if data.get("status") == "ok":
                    self.log_result("health_checks", "/api/crm/health endpoint (proxied)", True)
                    print(f"   CRM Status: {data.get('status', 'Unknown')}")
                    
                    # Check MongoDB connection info if available
                    mongodb_info = data.get("mongodb", {})
                    if mongodb_info:
                        print(f"   MongoDB State: {mongodb_info.get('state', 'Unknown')}")
                        print(f"   MongoDB Database: {mongodb_info.get('database', 'Unknown')}")
                else:
                    self.log_result("health_checks", "/api/crm/health endpoint (proxied)", False, "CRM backend not OK")
            except json.JSONDecodeError:
                self.log_result("health_checks", "/api/crm/health endpoint (proxied)", False, "Invalid JSON response")
        else:
            self.log_result("health_checks", "/api/crm/health endpoint (proxied)", False, f"HTTP {response.status_code if response else 'No response'}")

    def test_cors_headers(self):
        """Test CORS headers as specified in review request"""
        print("\n🌐 Testing CORS Headers...")
        
        # Test origins that should be allowed based on the dynamic CORS configuration
        test_origins = [
            os.environ.get("TEST_GATEWAY_URL", "http://localhost:8001"),  # Current preview URL
            os.environ.get("TEST_GATEWAY_URL", "http://localhost:8001"),   # Different preview subdomain
            "https://main.emergentagent.com",                  # Main domain
            "http://localhost:3000"                            # Local development
        ]
        
        for origin in test_origins:
            print(f"\n   Testing CORS for origin: {origin}")
            
            # Test with /api/health endpoint
            response = self.make_request_with_origin(self.health_endpoint, origin)
            
            if response and response.status_code == 200:
                # Check required CORS headers
                cors_origin = response.headers.get("Access-Control-Allow-Origin")
                cors_credentials = response.headers.get("Access-Control-Allow-Credentials")
                
                if cors_origin == origin and cors_credentials == "true":
                    self.log_result("cors_headers", f"CORS headers for {origin}", True)
                    print(f"   ✅ Access-Control-Allow-Origin: {cors_origin}")
                    print(f"   ✅ Access-Control-Allow-Credentials: {cors_credentials}")
                else:
                    self.log_result("cors_headers", f"CORS headers for {origin}", False, 
                                  f"Origin: {cors_origin}, Credentials: {cors_credentials}")
                    print(f"   ❌ Access-Control-Allow-Origin: {cors_origin} (expected: {origin})")
                    print(f"   ❌ Access-Control-Allow-Credentials: {cors_credentials} (expected: true)")
            else:
                self.log_result("cors_headers", f"CORS test for {origin}", False, 
                              f"HTTP {response.status_code if response else 'No response'}")

    def test_api_gateway_proxy(self):
        """Test API Gateway Proxy functionality"""
        print("\n🔄 Testing API Gateway Proxy...")
        
        # Test that /api/crm/* routes are properly proxied to CRM backend
        proxy_test_endpoints = [
            "/api/crm/health",
            # Add more endpoints if they exist and are publicly accessible
        ]
        
        for endpoint in proxy_test_endpoints:
            full_url = f"{self.gateway_url}{endpoint}"
            print(f"\n   Testing proxy: {endpoint}")
            
            response = self.make_request_with_origin(full_url)
            
            if response:
                if response.status_code == 200:
                    try:
                        data = response.json()
                        # Check if response looks like it came from CRM backend
                        if data.get("status") == "ok" or "mongodb" in data:
                            self.log_result("api_gateway_proxy", f"Proxy to {endpoint}", True)
                            print(f"   ✅ Successfully proxied to CRM backend")
                            print(f"   Response contains CRM-specific data")
                        else:
                            self.log_result("api_gateway_proxy", f"Proxy to {endpoint}", False, 
                                          "Response doesn't appear to be from CRM backend")
                    except json.JSONDecodeError:
                        self.log_result("api_gateway_proxy", f"Proxy to {endpoint}", False, "Invalid JSON response")
                elif response.status_code == 401 or response.status_code == 403:
                    # Authentication required is acceptable for some endpoints
                    self.log_result("api_gateway_proxy", f"Proxy to {endpoint}", True)
                    print(f"   ✅ Proxy working (authentication required: {response.status_code})")
                else:
                    self.log_result("api_gateway_proxy", f"Proxy to {endpoint}", False, 
                                  f"HTTP {response.status_code}")
            else:
                self.log_result("api_gateway_proxy", f"Proxy to {endpoint}", False, "No response")

    def run_all_tests(self):
        """Run all environment-agnostic tests"""
        print("🧪 ENVIRONMENT-AGNOSTIC API CONFIGURATION TESTING...")
        print("Testing frontend-backend connectivity using relative URLs")
        
        # Run all tests as specified in review request
        self.test_health_checks()
        self.test_cors_headers()
        self.test_api_gateway_proxy()
        
        # Print summary
        success = self.print_summary()
        return success

    def print_summary(self):
        """Print test results summary"""
        print("\n" + "=" * 60)
        print("📊 ENVIRONMENT-AGNOSTIC TEST RESULTS")
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
            print("🎉 ALL ENVIRONMENT-AGNOSTIC TESTS PASSED!")
            print("✅ Frontend can connect to backend using relative URLs")
            print("✅ CORS configuration supports URL changes")
            print("✅ API Gateway proxy is working correctly")
            return True
        else:
            print("⚠️  SOME TESTS FAILED!")
            print("❌ Environment-agnostic configuration needs attention")
            return False

def main():
    """Main function"""
    tester = EnvironmentAgnosticTester()
    success = tester.run_all_tests()
    
    # Exit with appropriate code
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()