# Two-version fixture corpora

`v9.0` and `v9.1` exist to prove the thing the engine promises but had never
been made to do: that two corpus versions load side by side, and that an audit
pinned to one is graded by that one.

They are deliberately outside `corpus/`, so the version-discovery loop in
`corpus.test.ts` does not pick them up and a real version directory is never
shadowed by a test double. The version numbers are far from any real one for
the same reason.

`v9.1` is `v9.0` plus a check, minus a check, with one check's automation tier
changed — the three things a methodology revision actually does.
