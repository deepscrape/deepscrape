---
name: role-plan-agent
description: Describe when to use this prompt
disable-model-invocation: true
---
Create an implementation plan for this platform codebase to introduce a production-ready authorization architecture.

Hard requirements:
- Follow all repository and project rules/instructions.
- Do NOT use classic RBAC.
- Use a model better suited to this platform: ReBAC (relationship-based access control) with ABAC policy conditions where needed.
- Keep backward compatibility and provide a safe migration path.

Plan output requirements:
1. Current-state audit
   - Map existing auth/authz logic in frontend, backend, cloud functions, and middleware.
   - Identify implicit permission checks, duplicated logic, and security gaps.
2. Target architecture
   - Define core authorization concepts (principals, resources, relationships, actions, context attributes).
   - Specify policy decision and policy enforcement points across the stack.
   - Choose policy storage/evaluation approach and explain why it fits this codebase.
3. Incremental rollout plan
   - Break into phases with explicit file/module touchpoints.
   - Include migration strategy from existing checks to ReBAC+ABAC policies.
   - Include feature flags, fallbacks, and rollback strategy.
4. Security and reliability
   - Threat model for authorization bypass, privilege escalation, stale relationship data, and cache poisoning.
   - Logging/audit trail requirements for policy decisions.
   - Performance constraints and caching/invalidation plan.
5. Validation strategy
   - Unit, integration, and end-to-end test plan for authorization correctness.
   - Negative tests for denied access and cross-tenant/resource boundary violations.
6. Deliverables
   - ADR outline, policy schema draft, migration checklist, and phased task list with effort/risk per phase.

Output format:
- Concise, actionable phases with dependencies.
- Call out assumptions and open questions clearly.
- No implementation code; planning only.