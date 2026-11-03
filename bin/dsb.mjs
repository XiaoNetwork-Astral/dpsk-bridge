#!/usr/bin/env node
import fs from 'node:fs';
import {
  runJob,
  readJob,
  status,
  result,
  retryJob,
  reviewJob,
  cancelJob,
  unlockJob,
  stats,
  briefText,
  sendMessage,
  answerRequest,
  eventsPage,
  waitJob,
} from '../lib/bridge.mjs';
import { parse, rootHelp, commandHelp } from '../lib/cli.mjs';

const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const helpColumns = () =>
  process.stdout.isTTY && Number.isInteger(process.stdout.columns) && process.stdout.columns > 0
    ? process.stdout.columns
    : 100;
try {
  const plan = parse(process.argv.slice(2));
  if (plan.action === 'help') {
    process.stdout.write(
      (plan.command
        ? commandHelp(plan.command, { columns: helpColumns() })
        : rootHelp({ columns: helpColumns() })) + '\n',
    );
  } else if (plan.action === 'version') {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    process.stdout.write(`${packageJson.version}\n`);
  } else {
    const { command, options, positionals } = plan;
    if (command === 'run') {
      const job = await runJob(options, emit);
      emit({ event: 'finished', ...result(job) });
      process.exitCode = job.processState === 'completed' && job.reportedResult === 'OK' ? 0 : 1;
    } else if (command === 'stats') {
      emit(stats());
    } else {
      const job = readJob(positionals.id);
      if (command === 'status') emit(status(job));
      else if (command === 'wait') emit(await waitJob(job, options.timeout));
      else if (command === 'result') emit(result(job));
      else if (command === 'cancel') emit(cancelJob(job));
      else if (command === 'unlock') emit(await unlockJob(job, options.confirmStopped));
      else if (command === 'send') emit(sendMessage(job, briefText(options.message, 'Message')));
      else if (command === 'answer')
        emit(
          answerRequest(
            job,
            options.request,
            JSON.parse(briefText(options.answer, 'Answer')),
            undefined,
            !!options.userOk,
          ),
        );
      else if (command === 'events') emit(eventsPage(job, options.cursor, options.limit));
      else if (command === 'review')
        emit(
          reviewJob(
            job,
            options.verdict,
            options.note,
            undefined,
            options.accounting
              ? JSON.parse(fs.readFileSync(options.accounting, 'utf8').replace(/^\uFEFF/, ''))
              : null,
          ),
        );
      else if (command === 'retry') {
        const next = await retryJob(job, briefText(options.feedback, 'Feedback'), emit, undefined, {
          userOk: !!options.userOk,
          resume: !!options.resume,
        });
        emit({ event: 'finished', ...result(next) });
        process.exitCode =
          next.processState === 'completed' && next.reportedResult === 'OK' ? 0 : 1;
      } else throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (error) {
  emit({ error: error.message });
  process.exitCode = 1;
}
