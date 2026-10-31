// Validation of client-supplied tool contracts before an adapter returns any action to Codex.
// Unknown annotation keywords are harmless; supported structural constraints apply recursively.
import { isRecord } from '../json';

function equalJson(left: unknown, right: unknown, depth = 0): boolean {
  if (left === right) return true;
  if (depth > 64) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, i) => equalJson(value, right[i], depth + 1));
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key], depth + 1));
}
/** A field name safe to put in a diagnostic: model-written names that look like content are masked. */
export const fieldName = (name: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : '(field)';
const field = fieldName;

/**
 * Checks a function call's arguments against its contract. Models swap a parameter name (`command`
 * for `cmd`), which is reported as missing; undeclared top-level extras (models like adding
 * `description`) carry no meaning for the tool and are deleted from `args` before the full schema
 * check. Nested contracts are checked recursively.
 */
export function checkToolArguments(args: Record<string, unknown>, contract: unknown): { declared: string[]; missing: string[]; dropped: string[]; issue?: string } {
  const properties = isRecord(contract) && isRecord(contract.properties) ? contract.properties : undefined;
  const declared = properties ? Object.keys(properties) : [];
  const required = isRecord(contract) && Array.isArray(contract.required) ? contract.required.filter((key): key is string => typeof key === 'string') : [];
  const missing = required.filter(key => !Object.hasOwn(args, key));
  const dropped = properties && isRecord(contract) && contract.additionalProperties === false && !contract.patternProperties ? Object.keys(args).filter(key => !Object.hasOwn(properties, key)) : [];
  if (missing.length) return { declared, missing, dropped };
  for (const key of dropped) delete args[key];
  return { declared, missing, dropped, issue: toolSchemaIssue(args, contract) };
}

/** Returns the first content-free schema issue. No argument values enter diagnostics. */
function toolSchemaIssue(value: unknown, contract: unknown): string | undefined {
  let budget = 100_000;
  let exhausted = false;
  const check = (value: unknown, schema: unknown, path: string, depth = 0): string | undefined => {
    if (--budget < 0 || depth > 64) { exhausted = true; return `${path} exceeds the schema validation budget`; }
    if (schema === false) return `${path} is not allowed by its schema`;
    if (!isRecord(schema)) return undefined;
    if (typeof schema.$ref === 'string') {
      let referenced: unknown = contract;
      if (schema.$ref === '#') referenced = contract;
      else if (schema.$ref.startsWith('#/')) {
        for (const part of schema.$ref.slice(2).split('/')) {
          const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
          referenced = isRecord(referenced) && Object.hasOwn(referenced, key) ? referenced[key] : undefined;
        }
      } else referenced = undefined;
      if (referenced === undefined) return `${path} has an unresolved schema reference`;
      const issue = check(value, referenced, path, depth + 1);
      if (issue) return issue;
    }
    const matchesType = (type: unknown): boolean => {
      switch (type) {
        case 'null': return value === null;
        case 'object': return isRecord(value);
        case 'array': return Array.isArray(value);
        case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'string': return typeof value === 'string';
        case 'boolean': return typeof value === 'boolean';
        default: return false;
      }
    };
    if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type.some(matchesType) : matchesType(schema.type))) return `${path} has the wrong value type`;
    if (Object.hasOwn(schema, 'const') && !equalJson(value, schema.const)) return `${path} differs from its required constant`;
    if (Array.isArray(schema.enum) && !schema.enum.some(option => equalJson(value, option))) return `${path} is outside its allowed enum`;
    if (Array.isArray(schema.allOf)) for (const child of schema.allOf) { const issue = check(value, child, path, depth + 1); if (issue) return issue; }
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some(child => !check(value, child, path, depth + 1))) return `${path} matches none of its allowed alternatives`;
    if (Array.isArray(schema.oneOf) && schema.oneOf.filter(child => !check(value, child, path, depth + 1)).length !== 1) return `${path} must match exactly one schema alternative`;
    if (Object.hasOwn(schema, 'not') && !check(value, schema.not, path, depth + 1)) return `${path} matches a forbidden schema`;
    if (Object.hasOwn(schema, 'if')) {
      const branch = !check(value, schema.if, path, depth + 1) ? schema.then : schema.else;
      if (branch !== undefined) { const issue = check(value, branch, path, depth + 1); if (issue) return issue; }
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return `${path} must be finite`;
      if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} is below its minimum`;
      if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} exceeds its maximum`;
      if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return `${path} is below its exclusive minimum`;
      if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return `${path} exceeds its exclusive maximum`;
      if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
        const quotient = value / schema.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > Math.max(1, Math.abs(quotient)) * Number.EPSILON * 8) return `${path} is not an allowed numeric multiple`;
      }
    }
    if (typeof value === 'string') {
      if (typeof schema.minLength === 'number' || typeof schema.maxLength === 'number') {
        const length = Array.from(value).length;
        if (typeof schema.minLength === 'number' && length < schema.minLength) return `${path} is shorter than its minimum length`;
        if (typeof schema.maxLength === 'number' && length > schema.maxLength) return `${path} exceeds its maximum length`;
      }
      if (typeof schema.pattern === 'string') {
        try { if (!new RegExp(schema.pattern).test(value)) return `${path} does not match its required pattern`; }
        catch { return `${path} has an invalid schema pattern`; }
      }
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} has too few items`;
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} has too many items`;
      const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : undefined;
      for (let i = 0; i < value.length; i++) {
        const child = tuple ? i < tuple.length ? tuple[i] : Array.isArray(schema.items) ? schema.additionalItems : schema.items : schema.items;
        if (child !== undefined) { const issue = check(value[i], child, `${path}[${i}]`, depth + 1); if (issue) return issue; }
      }
      if (schema.uniqueItems === true) for (let i = 0; i < value.length; i++) for (let j = 0; j < i; j++) {
        if (--budget < 0) { exhausted = true; return `${path} exceeds the schema validation budget`; }
        if (equalJson(value[i], value[j])) return `${path} must contain unique items`;
      }
      if (Object.hasOwn(schema, 'contains')) {
        const count = value.filter(item => !check(item, schema.contains, path, depth + 1)).length;
        if (count < (typeof schema.minContains === 'number' ? schema.minContains : 1) || typeof schema.maxContains === 'number' && count > schema.maxContains) return `${path} violates its required item count`;
      }
    }
    if (isRecord(value)) {
      const keys = Object.keys(value);
      if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) return `${path} has too few properties`;
      if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) return `${path} has too many properties`;
      if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === 'string' && !Object.hasOwn(value, key)) return `${path}.${field(key)} is required`;
      const properties = isRecord(schema.properties) ? schema.properties : {};
      for (const key of keys) {
        let declared = Object.hasOwn(properties, key);
        if (declared) { const issue = check(value[key], properties[key], `${path}.${field(key)}`, depth + 1); if (issue) return issue; }
        if (isRecord(schema.patternProperties)) for (const [pattern, child] of Object.entries(schema.patternProperties)) {
          let matches: boolean;
          try { matches = new RegExp(pattern).test(key); } catch { return `${path} has an invalid property pattern`; }
          if (matches) { declared = true; const issue = check(value[key], child, `${path}.${field(key)}`, depth + 1); if (issue) return issue; }
        }
        if (!declared && schema.additionalProperties !== undefined) { const issue = check(value[key], schema.additionalProperties, `${path}.${field(key)}`, depth + 1); if (issue) return issue; }
        if (schema.propertyNames !== undefined) { const issue = check(key, schema.propertyNames, path, depth + 1); if (issue) return issue; }
      }
      if (isRecord(schema.dependentRequired)) for (const [key, required] of Object.entries(schema.dependentRequired)) {
        if (Object.hasOwn(value, key) && Array.isArray(required)) for (const dependent of required) if (typeof dependent === 'string' && !Object.hasOwn(value, dependent)) return `${path}.${field(dependent)} is required`;
      }
    }
    return undefined;
  };
  const issue = check(value, contract, 'arguments');
  // A resource limit is not evidence that a schema did not match: `not`, `if` and alternative
  // branches may invert ordinary mismatches. Once evaluation is incomplete, no branch can accept.
  return exhausted ? 'arguments exceeds the schema validation budget' : issue;
}
