# Integration Tests

All integration tests live here. **Do not hardcode credentials.**

## Required environment variables

```bash
export TEST_GATEWAY_URL=http://localhost:8001
export TEST_ADMIN_EMAIL=admin@yourdomain.com
export TEST_ADMIN_PASSWORD=<your-admin-password>
```

## Running tests

```bash
cd tests
python backend_test.py
python bug_fixes_test.py
```
