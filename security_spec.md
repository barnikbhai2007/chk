# Firebase Security Specification

## 1. Data Invariants
- **Checks**:
  - `steamId` must be a valid 64-bit ID string.
  - `credentials` must be in `user:pass` format.
  - `timestamp` must be the server time.
  - Read access is restricted to users with the `admin` role in the `/admins/` collection.
  - Creation is handled server-side via Admin SDK, but rules should still prevent unauthorized client writes.

## 2. The "Dirty Dozen" Payloads (Unauthorized Attempts)
1. **P1 (Anonymous Read)**: Attempt to list `/checks` without login. (Expected: DENIED)
2. **P2 (Standard User Read)**: User logged in but not in `/admins/` list tries to read `/checks`. (Expected: DENIED)
3. **P3 (Direct Client Write)**: Attempt to push a fake check from the browser. (Expected: DENIED)
4. **P4 (Identity Spoofing)**: Attempt to read another user's profile if we had users (N/A for now but good practice).
5. **P5 (Admin List Write)**: Attempt to add oneself to `/admins/`. (Expected: DENIED)
6. **P6 (Metadata Injection)**: Attempt to add fields like `isVerified: true` to a profile if we had them.
7. **P7 (Resource Poisoning)**: Document ID with 1MB string. (Expected: DENIED via `isValidId`)
8. **P8 (Timestamp Spoofing)**: Sending a future `createdAt`. (Expected: DENIED via `request.time`)
9. **P9 (Terminal State Skip)**: Updating a completed check. (Expected: DENIED)
10. **P10 (Credential Scraping)**: Listing checks via `where` clauses without admin role. (Expected: DENIED)
11. **P11 (Admin Read on PII)**: Reading sensitive fields without being exactly THAT user or an admin.
12. **P12 (Orphaned Subresource)**: (N/A since no subcollections yet).

## 3. Test Runner
(Will be implemented in `firestore.rules.test.ts` if environment supports it, but I will focus on the rules logic first).
