# Use case: private tests for public OSS code

The motivating use case for `@cldmv/git-embedded` is open-source software that wants comprehensive test coverage running in CI but cannot afford to publish the full test suite. This document describes the threat model, the strategy, and the licensing considerations.

## The threat model

Comprehensive tests are a high-fidelity behavioral specification of the code under test. A test that asserts "given input X, the function produces output Y" describes a fact about the API at a level of abstraction far more compact and reusable than the source code itself. With AI tools that can convert behavioral specifications into working implementations, comprehensive tests become a near-complete substitute for the source code in the hands of someone who wants to reimplement the software.

The classical clean-room reimplementation defense — used most famously by Phoenix in 1984 to clone the IBM PC BIOS — relies on a two-team structure. A "dirty team" reads the original and produces a functional specification that strips protectable expression and retains only ideas, methods, and observable behaviors. A "clean team" implements from the spec without ever having seen the original. The output is functionally equivalent but legally non-derivative because no protected expression was copied.

The defense is strong when the dirty team is genuinely good at abstraction. It is weak when the "spec" they hand off is mostly the original code transliterated into prose — that intermediate spec is itself a derivative work, and so is the downstream output. Humans trained as engineers tend to be careful at this; large language models tend not to be, paraphrasing more than abstracting.

Comprehensive tests bypass the dirty team entirely. They are already a behavioral specification — that's their entire purpose — and they were written to be implementation-independent. A test file is _not_ a derivative work of the implementation in any meaningful sense; courts have held repeatedly that purely functional descriptions, API surfaces, and behavioral specifications are not protectable expression (Google v. Oracle 2021, Computer Associates v. Altai 1992, Sega v. Accolade 1992). The output produced by an AI given test files as input is not, on its face, substantially similar to the original code — especially if the reimplementation is in a different programming language.

The threat is therefore:

1. **Tests describe behavior, not expression** — they are exactly the kind of artifact that strips protectable expression while retaining functional content.
2. **Cross-language reimplementation collapses substantial-similarity arguments** — the output isn't even textually similar to the original.
3. **No attribution falls out naturally** — there is no claim of copying, so there is nothing to attribute.
4. **Scale** — one operator can reproduce a project in hours that took years to build.

For a project whose test suite is comprehensive (high line and branch coverage, configuration-matrix tests, edge cases worked out over time), publishing the tests publicly is materially equivalent to publishing the implementation behavioral spec. The current state of AI-copyright law (Doe v. GitHub, NYT v. OpenAI, Bartz v. Anthropic — see references at the end of this document) does not provide meaningful protection against this kind of laundering. Hiding the tests is the most direct mitigation.

## The strategy

The strategy this package supports has four components.

**Code in a public repository under an open-source license.** Default choice is whatever fits the project — MIT, Apache-2.0, or AGPL-3.0 if the project wants the strongest copyleft compatible with OSI's Open Source Definition. The code is publicly visible, freely cloneable, and openly contributable.

**Tests in a separate private repository under a more restrictive license.** Typical choice is a custom license that explicitly forbids use as AI training data, fine-tuning input, prompt input, runtime context, or any other machine-learning-pipeline ingestion. This is what shifts the legal posture from "you had no rights and ignored none of mine" to "you had to actively breach a stated term." See the licensing strategy section below.

**Public CI runs whatever public test surface exists** — lint, build, type-check, smoke tests, integration tests intended for community contributors. Fork pull requests run only this surface, by GitHub Actions' default behavior (secrets are not exposed to fork-PR workflow runs, which is the correct security posture).

**Private CI runs the full suite after merge to integration branches.** Workflows triggered by pushes to internal branches (`next`, `hotfixes`, release branches) have access to the secrets needed to clone the private tests repo, and run the full suite. If the full suite fails on an integration branch, the merge is reverted — a recoverable outcome, and secrets never touch fork-PR code.

The `@cldmv/git-embedded` hooks are what make this strategy ergonomic for maintainers locally. Without them, the maintainer's local clone has to manually keep the tests directory in sync with the parent on every checkout, switch, and bisect. With them, the standard git workflow works as expected — `git checkout <release-branch>` updates both the code and the tests to the snapshot that was tested against, and `git bisect` walks both repos correctly in lockstep.

## Why anonymous gitlinks specifically

Several alternatives were considered for tracking the pinned tests version:

- **A plain pin file** (`.tests-pin` committed in the parent containing the expected child SHA). Works, but the file's contents are publicly visible, and updating the pin requires a hook that rewrites the file before every commit. Standard git tooling (`git status`, `git bisect`) doesn't understand the file and won't help.
- **Git notes** on parent commits recording the child SHA. Most private — git notes are not displayed by GitHub or GitLab UIs, only via the CLI to someone who has explicitly fetched the notes ref. But notes require an extra push (`git push origin refs/notes/*`) on every change, and CI has to fetch and parse them.
- **A submodule with a real URL** in `.gitmodules`. Standard git automation works, but the child's URL is publicly advertised — the exact privacy leak the strategy is designed to avoid.
- **A submodule with a fake URL** in `.gitmodules`, overridden locally via `.git/config`. Git automation works because the registry entry exists; the URL leak is reduced because the public URL is a non-resolving decoy. But the decoy itself advertises "we are deliberately hiding the real URL," which signals more intent than no entry at all.
- **An anonymous gitlink** (gitlink in the tree with no `.gitmodules` entry). Most opaque — the public parent shows the gitlink and SHA but no URL, which could plausibly be a leftover, mistake, or any other innocuous explanation. Loses git's automation, which is the gap this package fills with its hooks.

The choice is partly aesthetic but mostly about how the parent repo presents itself to outside observers. The anonymous gitlink presents minimum signal: an embedded reference whose target is not declared, the way most other features in a repo work (you can see _that_ something exists without being told everything about _what_ it is).

## Licensing strategy

The hooks themselves are infrastructure. The licensing question is what to do with the actual tests in the private repo, which is where the bulk of the engineering investment lives.

A few practical points:

**Different licenses for different parts of a single repo are valid.** Copyright attaches at the file level; nothing in copyright law requires one license per repository. The standard mechanism is the [REUSE specification](https://reuse.software/) from FSF Europe, which puts a license header at the top of every file and a `LICENSES/` directory containing the full text of each license used.

**OSI's Open Source Definition (clause 6) forbids use-based restrictions.** "No discrimination against fields of endeavor" means "no AI training" is not, by OSI's definition, an open-source restriction. A custom license that includes such a clause is **source-available** rather than open source, and the project should describe itself accordingly.

**AGPL-3.0 is the strongest OSI-compliant copyleft.** It does not mention AI training, but its broad copyleft language plausibly catches AI-augmented derivative works. AGPL-licensed code can be argued to require any model trained on it to be released under AGPL, an argument AI companies dispute and which is not yet tested in court. Combined with explicit non-consent records, it is the best the OSI-compliant landscape currently offers.

**OpenRAIL family licenses** (BigCode OpenRAIL-M for code, BigScience RAIL for models) include AI-misuse clauses and downstream propagation requirements. They are explicitly not OSI open source but are well-defined and widely understood in the AI ecosystem.

**EU CDSM Article 4** gives rightsholders a legally-enforceable opt-out from text-and-data-mining in EU jurisdictions. Combined with a machine-readable opt-out signal (TDMRep, robots.txt, `noai` meta tags), it provides a concrete legal hook absent from US copyright law's current state.

A reasonable layering for the private tests repo is therefore:

1. AGPL-3.0 or a custom source-available license for the tests themselves
2. Explicit AI-training-and-derivation prohibition clause in the license text
3. Acceptable Use Policy on the project website documenting non-consent
4. REUSE-spec headers on every file
5. EU TDM opt-out signals on any hosted version

None of these provide certainty against the threat model, but they collectively shift the legal posture as far as currently available tools allow.

## What this package does not provide

- **A solution to the broader AI-and-copyright problem.** The hooks make a specific defensive posture (hide the tests) more ergonomic. They do not stop anyone who has already obtained the tests from doing whatever they want with them. They do not protect the public code from AI training (which is a separate question with separate answers).
- **Watermarking, canary tokens, or AI-output traceability.** Some practitioners embed unique identifiers in tests to detect if those tests later appear in model outputs. That is a complementary defense; this package neither implements nor opposes it.
- **Legal advice.** This document describes a strategy and references public cases. It is not a substitute for consultation with a lawyer for any specific situation.

## CI integration

The corresponding CI behavior — auto-detecting embedded gitlinks in workflow runs, cloning the corresponding private repos via the org bot App, running the full test suite — is provided by the CLDMV reusable workflows. See [`docs/conventions/embedded-tests-ci.md`](https://github.com/CLDMV/.github/blob/master/docs/conventions/embedded-tests-ci.md) in `CLDMV/.github` for the workflow design: the opt-in input (`enable_embedded_tests: true`), the two convention-only URL mappings (primary per-path `<repo>-<path-with-dashes>` and secondary consolidated `<repo>-embedded`), fork-PR silent-skip behavior, and the failure modes. The CLI in this package handles the local-machine side; the CLDMV workflows handle the CI side. Both work off the same anonymous-gitlink signal in the parent's tree. No tracked config file is involved on either side — keeping the mapping convention-only is what preserves the privacy intent of using anonymous gitlinks in the first place.

## References

- **Phoenix Technologies IBM PC BIOS clone (1984)** — the canonical clean-room reimplementation. Never actually litigated; the technique deterred IBM from suing.
- **Computer Associates v. Altai, 982 F.2d 693 (2d Cir. 1992)** — established the abstraction-filtration-comparison test still used today for evaluating substantial similarity in software.
- **Sega v. Accolade, 977 F.2d 1510 (9th Cir. 1992)** — reverse engineering for interoperability is fair use.
- **Sony v. Connectix, 203 F.3d 596 (9th Cir. 2000)** — reverse engineering the PlayStation BIOS to build an emulator was legal.
- **Google LLC v. Oracle America, Inc., 593 U.S. 1 (2021)** — API declarations are subject to fair use even when reimplemented.
- **Doe v. GitHub** (N.D. Cal., filed November 2022) — anonymous developers v. GitHub/Microsoft/OpenAI over Copilot training on open-source code. Most copyright claims dismissed over 2023-2024 on substantial-similarity grounds.
- **The New York Times v. Microsoft and OpenAI** (S.D.N.Y., filed December 2023) — NYT sued over training on its content; NYT demonstrated verbatim regurgitation, breaking the Copilot-style "no substantial similarity" defense. Ongoing as of writing.
- **Bartz v. Anthropic** (N.D. Cal., filed August 2024) — authors v. Anthropic over training on pirated book datasets. Mid-2025 ruling split the question: training on legitimately purchased books was fair use; using pirated copies was infringement.
- **REUSE Specification** (FSF Europe) — `https://reuse.software/`
- **EU CDSM Directive Article 4** — text-and-data-mining opt-out mechanism.
