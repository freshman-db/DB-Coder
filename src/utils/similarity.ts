function tokenizeWords(input: string): Set<string> {
  return new Set(input.toLowerCase().split(/\W+/).filter(Boolean));
}

export function wordJaccard(a: string, b: string): number {
  const leftTokens = tokenizeWords(a);
  const rightTokens = tokenizeWords(b);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersectionSize += 1;
    }
  }

  const unionSize = leftTokens.size + rightTokens.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}
