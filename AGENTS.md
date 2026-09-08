# seo-optimizer — agent instructions

Read [`CLAUDE.md`](./CLAUDE.md). It is the handoff document for this repository,
and it is the only one — what the packages are, how the pipeline fits together,
what the grader will and will not say, and which gotchas will bite you.

Then read [`ROADMAP.md`](./ROADMAP.md) for what is done, what is next, and the
decisions already made with their reasons. Update it in the same commit as the
code change when you complete something.

This file exists because several tools look for `AGENTS.md` by name. It is
deliberately a pointer rather than a copy: it was a copy once, and by the time
anyone noticed it was describing a pipeline whose grading step did not exist
yet and telling readers to run a corpus compile that would have discarded the
corpus. Two documents saying the same thing means one of them is wrong and
nobody knows which.
