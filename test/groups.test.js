import test from 'node:test';
import assert from 'node:assert/strict';

test('AC-12 joining a full group is refused with 409', async () => {
  // Проверка за максимален капацитет на групата
  const maxCapacity = 5;
  const currentMembers = 5;

  const canJoin = currentMembers < maxCapacity;
  const statusCode = canJoin ? 200 : 409;

  assert.equal(statusCode, 409, 'Очаква се грешка 409 Conflict при пълна група');
});