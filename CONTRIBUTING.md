# Contributing

## Issues

Open an issue for any and all requests, even if you are submitting a pull request. Every pull request is associated with an issue.

The issue's title and body carry a strong description of the problem. Your recommendations go in follow-on comments, not in the issue body.

## Commit messages

Commits follow the conventional commit format and are checked by commitlint. The format drives semantic versioning.

Write each header as `feat(nn): description`, where `feat` is the commit type and `nn` is the issue number. The whole header, including the type and scope, is under 50 characters wide. commitlint rejects any header of 50 characters or more.

Regular contributors working on an overarching feature may use `feat(topic):` instead. A topic is lower-case kebab-case, for example `feat(migrate): keep Save visible`.

Wrap the lines of the commit body and footer at 100 characters or fewer, because commitlint rejects longer lines.

To check a message before you commit, run `echo "feat(42): add thing" | pnpm commitlint`.

## Before you push

Run these checks locally:

```
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Pull requests

`main` is protected, and keeps a linear history.

- Changes reach `main` only through a pull request. Nobody pushes or force-pushes `main`.
- Keep each pull request to one coherent commit. To change it, amend the commit and force-push your branch.
- Pull requests merge by rebase only. The branch must be up to date with `main`, and all five CI checks must pass.
- Merging does not deploy. The maintainer deploys ([docs/DEPLOY.md](docs/DEPLOY.md)).

## Continuous integration

CI reports these checks: `lint`, `typecheck`, `test`, `build` and `commitlint`.

## License

Contributions are made under the GPL-3.0-or-later license that covers this project.
