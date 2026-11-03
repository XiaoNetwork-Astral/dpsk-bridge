import test from 'node:test';
import assert from 'node:assert/strict';
import { reportState } from '../lib/bridge.mjs';

test('the verdict is read from its own line near the top of the final reply', () => {
  assert.equal(reportState('RESULT: OK\nDone.'), 'OK');
  assert.equal(reportState('﻿  RESULT: FAIL — tests failed'), 'FAIL');
  assert.equal(reportState('Implemented the change.\n\n**RESULT: BLOCKED**\nNeeds a decision.'), 'BLOCKED');
  assert.equal(reportState('Summary\r\nRESULT: OK\r\n'), 'OK');
});

test('templates, fenced examples, and late or missing verdicts stay UNKNOWN', () => {
  assert.equal(reportState('Start with RESULT: OK|FAIL|BLOCKED.'), 'UNKNOWN');
  assert.equal(reportState('RESULT: OK|FAIL|BLOCKED'), 'UNKNOWN');
  assert.equal(reportState('Example:\n```\nRESULT: OK\n```\nNo verdict.'), 'UNKNOWN');
  assert.equal(reportState(`${'line\n'.repeat(10)}RESULT: OK`), 'UNKNOWN');
  assert.equal(reportState('Implemented the change.'), 'UNKNOWN');
});
