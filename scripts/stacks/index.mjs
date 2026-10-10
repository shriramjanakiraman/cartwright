// The stack modules the profiler runs, in order: language modules first, then platform modules (which can read
// the facts the earlier ones found). A new stack is one module here, plus a fixture and its expected profile in
// tests/ (see documentation/16-project-profile-and-guardrails.md).
import node from './node.mjs';
import python from './python.mjs';
import sfcc from './sfcc.mjs';

export default [node, python, sfcc];
