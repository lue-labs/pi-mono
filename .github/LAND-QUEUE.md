# Land queue

PRs in this repo merge through the serial land-queue lander
(`.github/workflows/land-queue.yml`), not by hand:

1. Get all review gates green.
2. Apply the **`ready-to-land`** label and walk away.

The lander updates the branch when behind `main`, retries one check flake,
and merges (merge commit) in queue order. Ejects come back as
`needs-rebase` / `land-failed` labels.

Canonical docs + smoke harness: `my-pi/docs/land-queue.md`
(template repo: `valkyriweb/my-pi`). Push credential: `CRAFT_PUSH_PAT`
(fine-grained PAT, pull-requests/contents/workflows write on this repo).
