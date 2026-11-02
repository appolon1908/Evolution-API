// Independently reviewed immutable synthetic-test findings only. Never print values.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function literalProofs(source, line, acorn) {
  const root = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const result = [];
  function walk(node, parents) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && node.loc.start.line <= line && node.loc.end.line >= line) {
      result.push({ start: node.start, end: node.end, value_sha256: digest(String(node.value)),
                    value_length: String(node.value).length, ancestors: parents });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) for (const child of value) walk(child, [...parents, node.type]);
      else if (value && typeof value === 'object') walk(value, [...parents, node.type]);
    }
  }
  walk(root, []);
  return result;
}

function verifyFinding(source, finding, acorn) {
  if (digest(source) !== finding.file_sha256) return false;
  const lines = source.split(/\r?\n/);
  if (digest(lines[finding.StartLine - 1] || '') !== finding.line_sha256) return false;
  const actual = literalProofs(source, finding.StartLine, acorn);
  return actual.length > 0 && JSON.stringify(actual) === JSON.stringify(finding.literal_proofs);
}

function main() {
  const [manifestPath, acornPath, outputPath] = process.argv.slice(2);
  const acorn = require(acornPath);
  const expectedManifestHash = process.env.REVIEWED_FIXTURE_MANIFEST_SHA256;
  const bytes = fs.readFileSync(manifestPath);
  if (digest(bytes) !== expectedManifestHash) throw new Error('Unreviewed fixture manifest; no exception written');
  const findings = JSON.parse(bytes);
  const fingerprints = [];
  for (const finding of findings) {
    if (!/^[a-f0-9]{40}$/.test(finding.Commit) || !finding.File.startsWith('test/')) throw new Error('Invalid reviewed object identity');
    const expected = `${finding.Commit}:${finding.File}:${finding.RuleID}:${finding.StartLine}`;
    if (expected !== finding.Fingerprint) throw new Error('Fingerprint identity mismatch');
    const source = execFileSync('git', ['show', `${finding.Commit}:${finding.File}`], { encoding: 'utf8' });
    if (!verifyFinding(source, finding, acorn)) throw new Error('Immutable source/line/AST proof mismatch; no exception written');
    fingerprints.push(finding.Fingerprint);
  }
  fs.writeFileSync(outputPath, fingerprints.join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ reviewed_synthetic_findings: findings.length, manifest_sha256: expectedManifestHash,
                               scope: 'exact immutable historical fingerprints only; effective tree unsuppressed' }));
}

module.exports = { digest, literalProofs, verifyFinding };
if (require.main === module) main();
