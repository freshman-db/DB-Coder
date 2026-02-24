---
name: db-coder-security-review
description: Use when performing security-focused code review or fixing security vulnerabilities
---

## Security Review Process

### Step 1: Identify attack surface
- List all external inputs (HTTP params, env vars, file reads, DB queries)
- Map data flow from input to output

### Step 2: Check OWASP Top 10
- Injection (SQL, command, XSS): No string concatenation in queries or shell commands
- Broken auth: Tokens validated, sessions managed properly
- Sensitive data exposure: No secrets in logs, env vars not leaked
- Security misconfiguration: Default configs reviewed
- Input validation: All external input validated at boundary

### Step 3: Fix and verify
- Write a test that demonstrates the vulnerability
- Implement the fix
- Verify the test now passes
- Check for similar patterns elsewhere in codebase
