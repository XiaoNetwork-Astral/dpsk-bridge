# Special tasks

Three kinds of work look fine piece by piece while the whole drifts: interfaces, prompts, and documentation. For these the host agent keeps the parts that need the whole in view, and dsh does the parts that can be checked against a clear target. Everything else in SKILL.md applies as usual.

## UI (interfaces, styles, interaction, terminal UIs)

The host agent decides how it looks and behaves: layout, wording, states, keys or controls, and what happens on each interaction. Put those decisions in the brief's `[Decided]` field, with a sketch, a screenshot of the current state, or a reference to an existing screen when that is clearer than words. dsh implements the design, whether it is a first version or a change to existing UI.

For acceptance, the host agent actually runs or renders the result and checks it on screen, with a screenshot or a terminal capture where possible; reading the code cannot show how it looks. Small visual fixes the host agent makes directly and notes in the review record. When the result still looks wrong after the one rework, show the user the current state and let them decide.

## Prompts (skills, system prompts, brief templates, text a model will read)

The host agent writes the prompt, or at least reads the whole final text and settles it. dsh collects the material: the facts the prompt must state (commands, flags, defaults, file paths, behavior), checked against the code, with locations. Phrase the prompt by the rules in "Write a short, self-contained brief" in SKILL.md: say what to do, bound by what is allowed, and state a limit once, with its alternative, only where it is needed.

## Documentation (READMEs, guides, reference pages)

The host agent decides the structure: who it is for, which sections, and what each one covers. dsh can collect facts and draft individual sections against that outline. The host agent then reads the full text once, for consistency, repetition, and order, since each section can read well on its own while the whole becomes confusing.
