"""
CRM API Backend Tests
Tests for: Tool CRUD, Bulk Assignment, Activity Log
API Base: /api/crm/
"""
import pytest
import requests
import os
import time
from datetime import datetime, timedelta

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')

# Test credentials
ADMIN_EMAIL = os.environ.get("TEST_ADMIN_EMAIL")
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD")


class TestAdminAuth:
    """Admin authentication tests"""
    
    def test_admin_login_success(self):
        """Test admin login with valid credentials"""
        response = requests.post(f"{BASE_URL}/api/crm/auth/admin/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200, f"Login failed: {response.text}"
        data = response.json()
        assert "accessToken" in data, "No accessToken in response"
        assert "user" in data, "No user in response"
        print(f"✓ Admin login successful for {ADMIN_EMAIL}")
        return data.get("accessToken")
    
    def test_admin_login_invalid_credentials(self):
        """Test admin login with invalid credentials"""
        response = requests.post(f"{BASE_URL}/api/crm/auth/admin/login", json={
            "email": "wrong@email.com",
            "password": "wrongpassword"
        })
        assert response.status_code in [401, 400], f"Expected 401/400, got {response.status_code}"
        print("✓ Invalid credentials rejected correctly")


@pytest.fixture(scope="module")
def admin_token():
    """Get admin auth token for authenticated requests"""
    response = requests.post(f"{BASE_URL}/api/crm/auth/admin/login", json={
        "email": ADMIN_EMAIL,
        "password": ADMIN_PASSWORD
    })
    if response.status_code != 200:
        pytest.skip(f"Admin login failed: {response.text}")
    data = response.json()
    return data.get("accessToken")


@pytest.fixture
def auth_headers(admin_token):
    """Headers with auth token"""
    return {
        "Authorization": f"Bearer {admin_token}",
        "Content-Type": "application/json"
    }


class TestToolCRUD:
    """Tool CRUD operations tests"""
    
    def test_list_tools(self, auth_headers):
        """Test listing all tools"""
        response = requests.get(f"{BASE_URL}/api/crm/admin/tools", headers=auth_headers)
        assert response.status_code == 200, f"List tools failed: {response.text}"
        data = response.json()
        assert "tools" in data, "No tools array in response"
        print(f"✓ Listed {len(data['tools'])} tools")
    
    def test_create_tool_success(self, auth_headers):
        """Test creating a new tool with all required fields"""
        tool_data = {
            "name": f"TEST_Tool_{int(time.time())}",
            "description": "Test tool description for automated testing",
            "targetUrl": "https://test-tool.example.com",
            "category": "AI",
            "status": "active"
        }
        
        response = requests.post(f"{BASE_URL}/api/crm/admin/tools", 
                                 headers=auth_headers, 
                                 json=tool_data)
        
        assert response.status_code == 201, f"Create tool failed: {response.text}"
        data = response.json()
        assert "tool" in data, "No tool in response"
        assert data["tool"]["name"] == tool_data["name"], "Tool name mismatch"
        assert data["tool"]["category"] == tool_data["category"], "Category mismatch"
        print(f"✓ Created tool: {data['tool']['name']}")
        return data["tool"]
    
    def test_create_tool_validation_error(self, auth_headers):
        """Test tool creation with missing required fields"""
        # Missing targetUrl
        tool_data = {
            "name": "Test Tool Without URL",
            "description": "Missing URL"
        }
        
        response = requests.post(f"{BASE_URL}/api/crm/admin/tools", 
                                 headers=auth_headers, 
                                 json=tool_data)
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        print("✓ Validation error returned for missing targetUrl")
    
    def test_create_tool_invalid_category(self, auth_headers):
        """Test tool creation with invalid category"""
        tool_data = {
            "name": "Test Tool Invalid Category",
            "targetUrl": "https://example.com",
            "category": "InvalidCategory"
        }
        
        response = requests.post(f"{BASE_URL}/api/crm/admin/tools", 
                                 headers=auth_headers, 
                                 json=tool_data)
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        print("✓ Validation error returned for invalid category")
    
    def test_get_tool_by_id(self, auth_headers):
        """Test getting a specific tool by ID"""
        # First create a tool
        tool_data = {
            "name": f"TEST_GetTool_{int(time.time())}",
            "targetUrl": "https://get-test.example.com",
            "category": "SEO"
        }
        create_response = requests.post(f"{BASE_URL}/api/crm/admin/tools", 
                                        headers=auth_headers, 
                                        json=tool_data)
        assert create_response.status_code == 201
        tool_id = create_response.json()["tool"]["_id"]
        
        # Get the tool
        response = requests.get(f"{BASE_URL}/api/crm/admin/tools/{tool_id}", 
                               headers=auth_headers)
        assert response.status_code == 200, f"Get tool failed: {response.text}"
        data = response.json()
        assert data["tool"]["_id"] == tool_id, "Tool ID mismatch"
        print(f"✓ Retrieved tool by ID: {tool_id}")
    
    def test_update_tool(self, auth_headers):
        """Test updating a tool"""
        # First create a tool
        tool_data = {
            "name": f"TEST_UpdateTool_{int(time.time())}",
            "targetUrl": "https://update-test.example.com",
            "category": "Productivity"
        }
        create_response = requests.post(f"{BASE_URL}/api/crm/admin/tools", 
                                        headers=auth_headers, 
                                        json=tool_data)
        assert create_response.status_code == 201
        tool_id = create_response.json()["tool"]["_id"]
        
        # Update the tool
        update_data = {
            "name": f"TEST_UpdatedTool_{int(time.time())}",
            "status": "inactive"
        }
        response = requests.put(f"{BASE_URL}/api/crm/admin/tools/{tool_id}", 
                               headers=auth_headers, 
                               json=update_data)
        assert response.status_code == 200, f"Update tool failed: {response.text}"
        data = response.json()
        assert data["tool"]["status"] == "inactive", "Status not updated"
        print(f"✓ Updated tool: {tool_id}")
    
    def test_delete_tool(self, auth_headers):
        """Test deleting a tool"""
        # First create a tool
        tool_data = {
            "name": f"TEST_DeleteTool_{int(time.time())}",
            "targetUrl": "https://delete-test.example.com",
            "category": "Other"
        }
        create_response = requests.post(f"{BASE_URL}/api/crm/admin/tools", 
                                        headers=auth_headers, 
                                        json=tool_data)
        assert create_response.status_code == 201
        tool_id = create_response.json()["tool"]["_id"]
        
        # Delete the tool
        response = requests.delete(f"{BASE_URL}/api/crm/admin/tools/{tool_id}", 
                                  headers=auth_headers)
        assert response.status_code == 200, f"Delete tool failed: {response.text}"
        
        # Verify deletion
        get_response = requests.get(f"{BASE_URL}/api/crm/admin/tools/{tool_id}", 
                                   headers=auth_headers)
        assert get_response.status_code == 404, "Tool should be deleted"
        print(f"✓ Deleted tool: {tool_id}")


class TestBulkAssignment:
    """Bulk tool assignment tests"""
    
    def test_bulk_assign_tool(self, auth_headers):
        """Test bulk assigning a tool to multiple clients"""
        # First get available tools and clients
        tools_response = requests.get(f"{BASE_URL}/api/crm/admin/tools", headers=auth_headers)
        clients_response = requests.get(f"{BASE_URL}/api/crm/admin/clients", headers=auth_headers)
        
        assert tools_response.status_code == 200, f"Get tools failed: {tools_response.text}"
        assert clients_response.status_code == 200, f"Get clients failed: {clients_response.text}"
        
        tools = tools_response.json().get("tools", [])
        clients = clients_response.json().get("clients", [])
        
        if not tools:
            pytest.skip("No tools available for bulk assignment test")
        if not clients:
            pytest.skip("No clients available for bulk assignment test")
        
        # Get active tool and clients
        active_tools = [t for t in tools if t.get("status") == "active"]
        active_clients = [c for c in clients if c.get("status") == "active"]
        
        if not active_tools:
            pytest.skip("No active tools available")
        if not active_clients:
            pytest.skip("No active clients available")
        
        tool_id = active_tools[0]["_id"]
        client_ids = [c["_id"] for c in active_clients[:2]]  # Take up to 2 clients
        
        # Calculate dates
        start_date = datetime.now().strftime("%Y-%m-%d")
        end_date = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d")
        
        bulk_data = {
            "toolId": tool_id,
            "clientIds": client_ids,
            "startDate": start_date,
            "endDate": end_date
        }
        
        response = requests.post(f"{BASE_URL}/api/crm/admin/assignments/bulk", 
                                headers=auth_headers, 
                                json=bulk_data)
        
        assert response.status_code == 200, f"Bulk assign failed: {response.text}"
        data = response.json()
        assert data.get("success") == True, "Bulk assign not successful"
        assert "results" in data, "No results in response"
        print(f"✓ Bulk assigned tool to {len(client_ids)} clients")
        print(f"  Results: created={data['results'].get('created', 0)}, updated={data['results'].get('updated', 0)}")
    
    def test_bulk_assign_missing_tool_id(self, auth_headers):
        """Test bulk assign with missing tool ID"""
        bulk_data = {
            "clientIds": ["some-client-id"],
            "startDate": "2026-01-01",
            "endDate": "2026-02-01"
        }
        
        response = requests.post(f"{BASE_URL}/api/crm/admin/assignments/bulk", 
                                headers=auth_headers, 
                                json=bulk_data)
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        print("✓ Bulk assign rejected without tool ID")
    
    def test_bulk_assign_empty_clients(self, auth_headers):
        """Test bulk assign with empty client list"""
        bulk_data = {
            "toolId": "some-tool-id",
            "clientIds": [],
            "startDate": "2026-01-01",
            "endDate": "2026-02-01"
        }
        
        response = requests.post(f"{BASE_URL}/api/crm/admin/assignments/bulk", 
                                headers=auth_headers, 
                                json=bulk_data)
        
        assert response.status_code == 400, f"Expected 400, got {response.status_code}"
        print("✓ Bulk assign rejected with empty client list")


class TestActivityLog:
    """Activity log tests"""
    
    def test_get_activity_log(self, auth_headers):
        """Test fetching activity log"""
        response = requests.get(f"{BASE_URL}/api/crm/admin/activity", headers=auth_headers)
        assert response.status_code == 200, f"Get activity failed: {response.text}"
        data = response.json()
        assert "activities" in data, "No activities in response"
        print(f"✓ Retrieved {len(data['activities'])} activity entries")
        
        # Check if activities have email info
        if data["activities"]:
            activity = data["activities"][0]
            print(f"  Sample activity: {activity.get('action')} by {activity.get('actorRole')}")
            # Check for email in actorId or meta
            has_email = (activity.get("actorId", {}).get("email") if activity.get("actorId") else None) or \
                        (activity.get("meta", {}).get("email") if activity.get("meta") else None)
            if has_email:
                print(f"  ✓ Email found in activity: {has_email}")
            else:
                print(f"  ⚠ No email found in activity entry")
    
    def test_activity_log_filter_by_role(self, auth_headers):
        """Test filtering activity log by role"""
        response = requests.get(f"{BASE_URL}/api/crm/admin/activity?role=ADMIN", 
                               headers=auth_headers)
        assert response.status_code == 200, f"Filter by role failed: {response.text}"
        data = response.json()
        
        # Verify all returned activities are from ADMIN role
        for activity in data.get("activities", []):
            assert activity.get("actorRole") == "ADMIN", f"Expected ADMIN role, got {activity.get('actorRole')}"
        print(f"✓ Filtered activities by ADMIN role: {len(data.get('activities', []))} entries")
    
    def test_activity_log_filter_by_action(self, auth_headers):
        """Test filtering activity log by action type"""
        response = requests.get(f"{BASE_URL}/api/crm/admin/activity?action=ADMIN_LOGIN", 
                               headers=auth_headers)
        assert response.status_code == 200, f"Filter by action failed: {response.text}"
        data = response.json()
        print(f"✓ Filtered activities by ADMIN_LOGIN: {len(data.get('activities', []))} entries")


class TestClients:
    """Client management tests"""
    
    def test_list_clients(self, auth_headers):
        """Test listing all clients"""
        response = requests.get(f"{BASE_URL}/api/crm/admin/clients", headers=auth_headers)
        assert response.status_code == 200, f"List clients failed: {response.text}"
        data = response.json()
        assert "clients" in data, "No clients array in response"
        print(f"✓ Listed {len(data['clients'])} clients")


# Cleanup fixture
@pytest.fixture(scope="module", autouse=True)
def cleanup_test_data(admin_token):
    """Cleanup TEST_ prefixed data after all tests"""
    yield
    
    headers = {
        "Authorization": f"Bearer {admin_token}",
        "Content-Type": "application/json"
    }
    
    # Get all tools and delete TEST_ prefixed ones
    try:
        response = requests.get(f"{BASE_URL}/api/crm/admin/tools", headers=headers)
        if response.status_code == 200:
            tools = response.json().get("tools", [])
            for tool in tools:
                if tool.get("name", "").startswith("TEST_"):
                    requests.delete(f"{BASE_URL}/api/crm/admin/tools/{tool['_id']}", headers=headers)
                    print(f"Cleaned up test tool: {tool['name']}")
    except Exception as e:
        print(f"Cleanup error: {e}")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
