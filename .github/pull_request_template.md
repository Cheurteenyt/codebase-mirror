## Round identity

- Round:
- Base SHA:
- Final code SHA audited by the external reviewer:
- Current PR head SHA:
- Work branch:
- Implementation handoff:
- External audit report(s):

## Summary

- What changed:
- Why it changed:
- User or developer impact:

## Scope

### Included

-

### Explicitly excluded

-

## Audit resolution

| Finding | Audit source | Decision | Resolution code commit | CI-validated head | Regression test | State |
|---------|--------------|----------|------------------------|-------------------|-----------------|-------|
| | | | | | | |

Use `CI_VERIFIED` only when GitHub Actions succeeded on the exact candidate
SHA. Link deferred or rejected findings to their evidence in the handoff.

## Validation

```text
command:
working_directory:
exit_code:
result:
```

- Candidate CI run:
- Final code audit report:
- Known skipped or unavailable validation:

## Reset-recovery confirmation

- [ ] All important commits are pushed.
- [ ] The remote branch head equals the intended candidate SHA.
- [ ] The active handoff identifies one next action or is ready to archive.
- [ ] No private key, token, secret path, bundle, or local recovery artifact is committed.

## Merge checklist

- [ ] All four required GitHub checks are green.
- [ ] Review conversations are resolved.
- [ ] Accepted findings are `CI_VERIFIED`.
- [ ] Deferred findings have an explicit owner or future round.
- [ ] Changes after the final audited code SHA are limited to audit and handoff documentation.
- [ ] The completed handoff is archived and `docs/ai/CURRENT_HANDOFF.md` is removed.
- [ ] Squash merge is selected.
- [ ] After merge, GitHub and GitLab `main` SHA parity will be verified.
