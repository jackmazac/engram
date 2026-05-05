/** Float32 BLOB from chunk.embedding — L2-normalized vectors from OpenAI */
export function blobToVec(b: Buffer | Uint8Array): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Number.NaN
  let d = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    d += x * y
  }
  return d
}

export function topKByCosine(
  query: Float32Array,
  rows: Iterable<{ id: string; blob: Buffer | Uint8Array }>,
  k: number,
): { id: string; score: number }[] {
  if (k <= 0) return []
  const best: { id: string; score: number }[] = []
  for (const r of rows) {
    if (r.blob.byteLength !== query.byteLength) continue
    const score = cosine(query, blobToVec(r.blob))
    if (!Number.isFinite(score)) continue
    const item = { id: r.id, score }
    if (best.length < k) {
      heapPush(best, item)
      continue
    }
    const worst = best[0]
    if (worst && score > worst.score) {
      best[0] = item
      heapDown(best, 0)
    }
  }
  return best.sort((a, b) => b.score - a.score)
}

function heapPush(heap: { id: string; score: number }[], item: { id: string; score: number }) {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    const parentItem = heap[parent]
    if (!parentItem || parentItem.score <= item.score) break
    heap[index] = parentItem
    index = parent
  }
  heap[index] = item
}

function heapDown(heap: { id: string; score: number }[], start: number) {
  const item = heap[start]
  if (!item) return
  let index = start
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index
    const leftItem = heap[left]
    const smallestItem = heap[smallest]
    if (leftItem && smallestItem && leftItem.score < smallestItem.score) smallest = left
    const rightItem = heap[right]
    const nextSmallestItem = heap[smallest]
    if (rightItem && nextSmallestItem && rightItem.score < nextSmallestItem.score) smallest = right
    if (smallest === index) break
    const swap = heap[smallest]
    if (!swap) break
    heap[index] = swap
    index = smallest
  }
  heap[index] = item
}
