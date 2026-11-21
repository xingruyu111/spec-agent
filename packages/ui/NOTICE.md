# NOTICE

`@spec-agent/ui` is an independent implementation for Spec Agent.

Its component API and visual specifications reference the open-source
DeepSeek Harness Web Client primitives:

- Repository: https://github.com/deepseek-ai/deepseek-harness
- Package: `packages/client/ui-primitives`
- License: MIT
- Copyright: DeepSeek

No DSH runtime package is bundled or imported. The local implementation uses
Spec Agent's own `--ui-*` tokens and plain CSS; DSH's `--dsw-*` values informed
the palette, control sizes, and states.

If code is copied from the upstream package in the future, retain the upstream
MIT copyright notice in the copied file.
