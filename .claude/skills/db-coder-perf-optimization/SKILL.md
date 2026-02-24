---
name: db-coder-perf-optimization
description: Use when optimizing code performance, fixing N+1 queries, or reducing latency
---

## Performance Optimization Process

### Step 1: Profile and measure
- Identify the bottleneck with concrete evidence (timing, query count, memory)
- Establish a baseline measurement

### Step 2: Optimize
- Fix N+1 queries: batch or join instead of loop queries
- Parallelize independent async operations: `Promise.all()` instead of sequential await
- Remove unnecessary work: dead code, redundant computations, unused imports
- Cache repeated computations where inputs are stable

### Step 3: Verify
- Measure again — confirm improvement
- Run all tests — no correctness regression
- Document the before/after improvement in commit message
