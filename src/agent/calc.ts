/**
 * 计算工具：手写递归下降解析器。
 *
 * 不用 eval 是有意的 —— 模型给出的表达式来自网络内容，任何"把字符串当代码执行"
 * 的做法在这个 App 里都是不必要的风险面。这里只认数字、四则运算、括号和几个函数。
 */

type Token = { kind: 'number' | 'name' | 'operator' | 'paren', value: string }

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index] as string
    if (/\s/.test(char)) { index += 1; continue }
    if (/[0-9.]/.test(char)) {
      let text = ''
      while (index < input.length && /[0-9._]/.test(input[index] as string)) {
        // 兼容千分位写法 1_000 / 1,000 → 去掉分隔符
        const current = input[index] as string
        if (current !== '_' && current !== ',') text += current
        index += 1
      }
      tokens.push({ kind: 'number', value: text })
      continue
    }
    if (/[a-zA-Z]/.test(char)) {
      let text = ''
      while (index < input.length && /[a-zA-Z0-9]/.test(input[index] as string)) {
        text += input[index]
        index += 1
      }
      tokens.push({ kind: 'name', value: text.toLowerCase() })
      continue
    }
    if ('+-*/%^(),'.includes(char)) {
      tokens.push({ kind: '(),'.includes(char) ? 'paren' : 'operator', value: char })
      index += 1
      continue
    }
    throw new Error(`不认识的字符：${char}`)
  }
  return tokens
}

/** 递归下降：expression → term → power → unary → primary */
export function evaluate(expression: string): number {
  const tokens = tokenize(expression)
  let position = 0

  const peek = (): Token | undefined => tokens[position]
  const eat = (value: string): boolean => {
    const token = peek()
    if (token !== undefined && token.value === value) { position += 1; return true }
    return false
  }

  function parsePrimary(): number {
    const token = peek()
    if (token === undefined) throw new Error('表达式不完整')

    if (token.kind === 'number') {
      position += 1
      const value = Number(token.value)
      if (!Number.isFinite(value)) throw new Error(`不是合法数字：${token.value}`)
      return value
    }

    if (token.kind === 'name') {
      position += 1
      if (eat('(')) {
        const args: number[] = []
        if (!eat(')')) {
          do { args.push(parseExpression()) } while (eat(','))
          if (!eat(')')) throw new Error('括号没闭上')
        }
        const fn = FUNCTIONS[token.value]
        if (fn === undefined) throw new Error(`没有这个函数：${token.value}`)
        return fn(...args)
      }
      const constant = CONSTANTS[token.value]
      if (constant === undefined) throw new Error(`没有这个常量：${token.value}`)
      return constant
    }

    if (eat('(')) {
      const value = parseExpression()
      if (!eat(')')) throw new Error('括号没闭上')
      return value
    }

    throw new Error(`看不懂：${token.value}`)
  }

  function parseUnary(): number {
    if (eat('-')) return -parseUnary()
    if (eat('+')) return parseUnary()
    return parsePower()
  }

  /** 幂右结合，且优先级高于一元负号：-2^2 = -(2^2) = -4，2^-3 也合法。 */
  function parsePower(): number {
    const base = parsePrimary()
    if (eat('^')) return Math.pow(base, parseUnary())
    return base
  }

  function parseTerm(): number {
    let value = parseUnary()
    for (;;) {
      if (eat('*')) value *= parseUnary()
      else if (eat('/')) {
        const divisor = parseUnary()
        if (divisor === 0) throw new Error('除以零')
        value /= divisor
      } else if (eat('%')) {
        const divisor = parseUnary()
        if (divisor === 0) throw new Error('对零取模')
        value %= divisor
      } else return value
    }
  }

  function parseExpression(): number {
    let value = parseTerm()
    for (;;) {
      if (eat('+')) value += parseTerm()
      else if (eat('-')) value -= parseTerm()
      else return value
    }
  }

  const result = parseExpression()
  if (position !== tokens.length) throw new Error(`表达式尾部多余内容：${tokens[position]?.value ?? ''}`)
  if (!Number.isFinite(result)) throw new Error('结果不是有限数')
  return result
}
