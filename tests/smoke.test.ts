import { DatabaseSync } from 'node:sqlite'
test('node:sqlite works in test runtime', () => {
  const db = new DatabaseSync(':memory:')
  expect(db.prepare('select 1 as x').get()).toEqual({ x: 1 })
})
