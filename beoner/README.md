# @beon-tech/beoner-ai-score

The [AI Workflow Score](https://github.com/BEON-Tech/ai-score) CLI for
**BEONers**. Your results show up in AI Coding Pulse, for you and — once your
project has AI Score enabled — your TEM and the partner's team.

```sh
npx @beon-tech/beoner-ai-score          # sign in with BEON Google if needed, scan, upload
npx @beon-tech/beoner-ai-score whoami   # which BEON account this machine submits as
npx @beon-tech/beoner-ai-score logout   # forget the BEON login
```

It is `@beon-tech/ai-score` with `--beon` always on: the browser sign-in asks
for your BEON Google account (the `beon.tech` Workspace), not GitHub, and that
login is kept apart from any other `ai-score` login on the machine. Everything
else — what is scanned, what is sent (counts, workflow states, timestamps and
one-way hashes; never code, prompts, paths or message text), `--audit`,
`--dry-run` — is exactly the same; see the
[main README](https://github.com/BEON-Tech/ai-score#readme).

Released together with `@beon-tech/ai-score`, at the same version.
