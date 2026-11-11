// services/groupService.js

export async function listGroups() {
  return [
    { id: 1, title: 'JavaScript Study Group', subject: 'JavaScript', max_capacity: 5, member_count: 2 },
    { id: 2, title: 'Node.js Backend', subject: 'Node.js', max_capacity: 5, member_count: 5 }
  ];
}

export async function getGroupById(id) {
  return {
    id: Number(id),
    title: 'Study Group ' + id,
    subject: 'General Programming',
    max_capacity: 5,
    member_count: 1
  };
}

export async function createGroup(data) {
  return {
    id: Date.now(),
    title: data.title,
    subject: data.subject,
    max_capacity: data.max_capacity,
    creator: data.creator || 'unknown',
    member_count: 1
  };
}