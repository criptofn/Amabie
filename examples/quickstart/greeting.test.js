import assert from 'node:assert/strict';
import test from 'node:test';
import { greeting } from './greeting.js';

test('greets a name', () => {
  assert.equal(greeting('Ada'), 'Hello, Ada!');
});
