/**
 * A small, safe expression language used by rate components for quantities,
 * conditions and custom variables. It never calls eval() and only knows a
 * fixed set of functions. All arithmetic is decimal-safe.
 *
 * Grammar (precedence low → high):
 *   or      := and ('||' and)*
 *   and     := cmp ('&&' cmp)*
 *   cmp     := add (('=='|'!='|'<'|'<='|'>'|'>=') add)?
 *   add     := mul (('+'|'-') mul)*
 *   mul     := unary (('*'|'/') unary)*
 *   unary   := ('-'|'!') unary | primary
 *   primary := number | string | ident | ident '(' args ')' | '(' or ')'
 */
import { D, type Dec, roundDp } from './decimal.js';

export type Value = Dec | string | boolean;
export type Scope = Record<string, Value | undefined>;

type Node =
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'var'; name: string }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'un'; op: '-' | '!'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node };

export class ExprError extends Error {}

const FUNCS = new Set(['max', 'min', 'ceil', 'floor', 'round', 'abs', 'if', 'in']);

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_.]*|==|!=|<=|>=|&&|\|\||[-+*/(),<>!])/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new ExprError(`Unexpected character at position ${i + 1}: "${src.slice(i, i + 10)}"`);
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

export function parse(src: string): Node {
  if (src.length > 2000) throw new ExprError('Expression too long');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: string) => {
    if (toks[p] !== t) throw new ExprError(`Expected "${t}" but found "${toks[p] ?? 'end'}"`);
    p++;
  };
  const orE = (): Node => {
    let a = andE();
    while (peek() === '||') { next(); a = { t: 'bin', op: '||', a, b: andE() }; }
    return a;
  };
  const andE = (): Node => {
    let a = cmpE();
    while (peek() === '&&') { next(); a = { t: 'bin', op: '&&', a, b: cmpE() }; }
    return a;
  };
  const cmpE = (): Node => {
    const a = addE();
    const op = peek();
    if (op && ['==', '!=', '<', '<=', '>', '>='].includes(op)) { next(); return { t: 'bin', op, a, b: addE() }; }
    return a;
  };
  const addE = (): Node => {
    let a = mulE();
    while (peek() === '+' || peek() === '-') { const op = next(); a = { t: 'bin', op, a, b: mulE() }; }
    return a;
  };
  const mulE = (): Node => {
    let a = unE();
    while (peek() === '*' || peek() === '/') { const op = next(); a = { t: 'bin', op, a, b: unE() }; }
    return a;
  };
  const unE = (): Node => {
    if (peek() === '-' || peek() === '!') { const op = next() as '-' | '!'; return { t: 'un', op, a: unE() }; }
    return prim();
  };
  const prim = (): Node => {
    const tok = next();
    if (tok === undefined) throw new ExprError('Unexpected end of expression');
    if (/^\d/.test(tok)) return { t: 'num', v: tok };
    if (tok.startsWith("'")) return { t: 'str', v: tok.slice(1, -1).replace(/\\(.)/g, '$1') };
    if (tok === '(') { const e = orE(); expect(')'); return e; }
    if (/^[A-Za-z_]/.test(tok)) {
      if (tok === 'true' || tok === 'false') return { t: 'num', v: tok === 'true' ? '1' : '0' };
      if (peek() === '(') {
        if (!FUNCS.has(tok)) throw new ExprError(`Unknown function "${tok}"`);
        next();
        const args: Node[] = [];
        if (peek() !== ')') {
          args.push(orE());
          while (peek() === ',') { next(); args.push(orE()); }
        }
        expect(')');
        return { t: 'call', fn: tok, args };
      }
      return { t: 'var', name: tok };
    }
    throw new ExprError(`Unexpected token "${tok}"`);
  };
  const ast = orE();
  if (p !== toks.length) throw new ExprError(`Unexpected token "${toks[p]}"`);
  return ast;
}

function num(v: Value, ctx: string): Dec {
  if (typeof v === 'boolean') return new D(v ? 1 : 0);
  if (typeof v === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(v)) return new D(v);
    throw new ExprError(`${ctx}: expected a number but got text "${v}"`);
  }
  return v;
}

export function truthy(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 0;
  return !v.isZero();
}

function eq(a: Value, b: Value): boolean {
  if (typeof a === 'string' || typeof b === 'string') return String(typeof a === 'object' ? a.toString() : a) === String(typeof b === 'object' ? b.toString() : b);
  return num(a, '==').eq(num(b, '=='));
}

function evalNode(n: Node, scope: Scope, used: Set<string>): Value {
  switch (n.t) {
    case 'num': return new D(n.v);
    case 'str': return n.v;
    case 'var': {
      const v = scope[n.name];
      if (v === undefined) throw new ExprError(`Unknown variable "${n.name}"`);
      used.add(n.name);
      return v;
    }
    case 'un': {
      const a = evalNode(n.a, scope, used);
      return n.op === '-' ? num(a, 'negation').neg() : !truthy(a);
    }
    case 'bin': {
      if (n.op === '&&') return truthy(evalNode(n.a, scope, used)) && truthy(evalNode(n.b, scope, used));
      if (n.op === '||') return truthy(evalNode(n.a, scope, used)) || truthy(evalNode(n.b, scope, used));
      const a = evalNode(n.a, scope, used);
      const b = evalNode(n.b, scope, used);
      switch (n.op) {
        case '==': return eq(a, b);
        case '!=': return !eq(a, b);
        case '<': return num(a, '<').lt(num(b, '<'));
        case '<=': return num(a, '<=').lte(num(b, '<='));
        case '>': return num(a, '>').gt(num(b, '>'));
        case '>=': return num(a, '>=').gte(num(b, '>='));
        case '+': return num(a, '+').add(num(b, '+'));
        case '-': return num(a, '-').sub(num(b, '-'));
        case '*': return num(a, '*').mul(num(b, '*'));
        case '/': {
          const d = num(b, '/');
          if (d.isZero()) throw new ExprError('Division by zero');
          return num(a, '/').div(d);
        }
      }
      throw new ExprError(`Unknown operator ${n.op}`);
    }
    case 'call': {
      const args = n.fn === 'if' ? [] : n.args.map((x) => evalNode(x, scope, used));
      switch (n.fn) {
        case 'if': {
          if (n.args.length !== 3) throw new ExprError('if(condition, then, else) needs 3 arguments');
          return truthy(evalNode(n.args[0], scope, used)) ? evalNode(n.args[1], scope, used) : evalNode(n.args[2], scope, used);
        }
        case 'max':
        case 'min': {
          if (args.length < 1) throw new ExprError(`${n.fn}() needs arguments`);
          const ds = args.map((a) => num(a, n.fn));
          return ds.reduce((x, y) => (n.fn === 'max' ? (y.gt(x) ? y : x) : (y.lt(x) ? y : x)));
        }
        case 'ceil':
        case 'floor': {
          const x = num(args[0], n.fn);
          const unit = args[1] !== undefined ? num(args[1], n.fn) : new D(1);
          if (unit.lte(0)) throw new ExprError(`${n.fn}() unit must be positive`);
          const q = x.div(unit);
          return (n.fn === 'ceil' ? q.ceil() : q.floor()).mul(unit);
        }
        case 'round': {
          const x = num(args[0], 'round');
          const dp = args[1] !== undefined ? num(args[1], 'round').toNumber() : 0;
          return roundDp(x, dp);
        }
        case 'abs': return num(args[0], 'abs').abs();
        case 'in': {
          if (args.length < 2) throw new ExprError('in(value, option1, ...) needs at least 2 arguments');
          return args.slice(1).some((o) => eq(args[0], o));
        }
      }
      throw new ExprError(`Unknown function ${n.fn}`);
    }
  }
}

export interface EvalResult { value: Value; used: string[] }

const cache = new Map<string, Node>();

export function evaluate(src: string, scope: Scope): EvalResult {
  let ast = cache.get(src);
  if (!ast) { ast = parse(src); if (cache.size > 5000) cache.clear(); cache.set(src, ast); }
  const used = new Set<string>();
  const value = evalNode(ast, scope, used);
  return { value, used: [...used] };
}

export function evaluateNumber(src: string, scope: Scope): { value: Dec; used: string[] } {
  const r = evaluate(src, scope);
  return { value: num(r.value, `"${src}"`), used: r.used };
}

/** Returns the variable names referenced by an expression, for validation in the UI. */
export function referencedVariables(src: string): string[] {
  const names = new Set<string>();
  const walk = (n: Node) => {
    if (n.t === 'var') names.add(n.name);
    else if (n.t === 'un') walk(n.a);
    else if (n.t === 'bin') { walk(n.a); walk(n.b); }
    else if (n.t === 'call') n.args.forEach(walk);
  };
  walk(parse(src));
  return [...names];
}
