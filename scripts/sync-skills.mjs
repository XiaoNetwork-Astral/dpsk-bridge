// Kept as a thin entry point for `npm run sync-skills` and existing callers.
// Cross-platform skill synchronization and all installer behavior live in
// installer-core.mjs; this file only invokes the `sync` command.
import { runCli } from './installer-core.mjs';

process.exitCode = await runCli(['sync']);
