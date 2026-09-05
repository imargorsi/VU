# Branches

VU Buddy is one repo with two long-lived editions. The Chrome package is always the `vu-deadlines/` folder.

| Branch | Who it is for | Todoist |
| --- | --- | --- |
| `main` | Other students | No |
| `todoist` | You | Yes |

## Use Todoist (your copy)

```bash
git checkout todoist
```

Then in Chrome: Load unpacked → `vu-deadlines/`.

## Share with students / Chrome Web Store

```bash
git checkout main
bash scripts/pack-chrome-store.sh
```

Upload `store/vu-buddy-*-chrome.zip`. Host `store/privacy-policy.html` on HTTPS for the listing. Do not zip `doc/` or the `todoist` branch.

Switch back afterwards:

```bash
git checkout todoist
```

## Bugfixes

Do **not** merge `main` and `todoist` as whole branches. That would add or delete Todoist files by accident.

- VULMS-only fixes: commit on one branch, then `git cherry-pick <commit>` onto the other.
- Todoist-only fixes: commit on `todoist` only.
