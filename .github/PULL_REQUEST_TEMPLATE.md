## Summary

<!-- What changed and why. Link related issues when applicable. Keep it short and imperative, following the repo's Conventional Commit style (feat:, fix:, chore:, ...). -->

## Code Review (Required)

> [!IMPORTANT]
> Every pull request in this repository **MUST** be reviewed with the project code-review skill before merge:
>
> - Skill: `copilot-api-code-review` (`.agents/skills/copilot-api-code-review/SKILL.md`)
> - Invoke it with a prompt such as: "Use the copilot-api-code-review skill to review this PR".
> - The review output is written in English and **MUST be pasted in full below** (Summary, Context Checked, CHANGESET_SUMMARY, CODE_REVIEW_SUMMARY, Test Notes, Release Risk).
> - A `BLOCKING` review decision must be resolved before merge. PRs without a completed code-review block will not be merged.

### Review Output

<!-- Paste the full copilot-api-code-review output here. Do not summarize or trim the CODE_REVIEW_SUMMARY block. -->

- **Summary**:
- **Context Checked**:
- **CHANGESET_SUMMARY**:
- **CODE_REVIEW_SUMMARY**:

  ```text
  Review Decision: BLOCKING | NON_BLOCKING
  Findings Total: <N> (CRITICAL=<n1>, HIGH_PRIORITY=<n2>, REFERENCE=<n3>)

  [CRITICAL]
  None

  [HIGH_PRIORITY]
  None

  [REFERENCE]
  None
  ```

- **Test Notes**:
- **Release Risk**: <!-- low / med / high + why -->

## Test Evidence

<!-- Check what you actually ran; CI enforces all of these. -->

- [ ] `bun run lint:all` passes
- [ ] `bun run typecheck` passes (root and `desktop/` when touched)
- [ ] `bun test` passes - targeted files run: <!-- e.g. bun test tests/provider-resolver.test.ts -->
- [ ] `bun run build` succeeds (`bun run build:desktop` for desktop/shared changes)

## Screenshots

<!-- Required for desktop or pages/ UI changes; delete this section otherwise. -->

## Notes

<!-- Migration/compatibility notes, follow-ups, or anything reviewers should know. -->
