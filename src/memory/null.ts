// Baseline-режим: памяти нет. Нужен как нижняя опорная точка кривой -
// всё, что режимы с памятью выигрывают, меряется относительно него.

import type { Hint, Lesson, Memory } from '../types.ts'

export class NullMemory implements Memory {
  async recall(_features: string[], _limit: number): Promise<Hint[]> {
    return []
  }

  async remember(_lesson: Lesson): Promise<void> {
    // no-op
  }

  async snapshot(): Promise<string> {
    return 'null-memory'
  }

  async restore(id: string): Promise<void> {
    if (id !== 'null-memory') throw new Error(`NullMemory не восстанавливает снапшот ${id}`)
  }
}
