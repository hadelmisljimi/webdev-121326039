export async function listGroups() {
  return [];
}

export async function getGroupById(id) {
  return { id, title: 'Sample Group' };
}

export async function createGroup(data) {
  return { id: 1, ...data };
}