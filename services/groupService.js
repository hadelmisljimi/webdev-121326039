import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
// Shared PostgreSQL pool for group operations / Споделен пул към PostgreSQL за учебните групи
const pool = new Pool({ connectionString: config.databaseUrl });

// Ensure study_groups and group_members tables exist / Гарантираме наличие на таблиците
export async function ensureStudyGroupsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_groups (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      max_capacity INT NOT NULL CHECK (max_capacity > 0),
      creator TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      id SERIAL PRIMARY KEY,
      group_id INT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// List all study groups with member counts / Списък с всички групи и броя на членовете им
export async function listGroups() {
  await ensureStudyGroupsTable();
  const res = await pool.query(`
    SELECT
      g.id,
      g.title,
      g.subject,
      g.max_capacity,
      g.creator,
      g.created_at,
      COUNT(gm.id)::int AS member_count
    FROM study_groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    GROUP BY g.id
    ORDER BY g.id ASC
  `);
  return res.rows;
}

// Fetch a single study group by ID / Връща детайли за конкретна група по ID
export async function getGroupById(id) {
  await ensureStudyGroupsTable();
  const res = await pool.query(
    `
    SELECT
      g.id,
      g.title,
      g.subject,
      g.max_capacity,
      g.creator,
      g.created_at,
      COUNT(gm.id)::int AS member_count
    FROM study_groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    WHERE g.id = $1
    GROUP BY g.id
    `,
    [id]
  );
  return res.rows[0] || null;
}

// Create a new study group in PostgreSQL / Създава нова учебна група в PostgreSQL
export async function createGroup(data) {
  await ensureStudyGroupsTable();
  const title = String(data.title || '').trim();
  const subject = String(data.subject || '').trim();
  const maxCapacity = Number(data.max_capacity);
  const creator = data.creator ? String(data.creator) : null;

  const res = await pool.query(
    `
    INSERT INTO study_groups (title, subject, max_capacity, creator)
    VALUES ($1, $2, $3, $4)
    RETURNING id, title, subject, max_capacity, creator, created_at
    `,
    [title, subject, maxCapacity, creator]
  );
  return { ...res.rows[0], member_count: 0 };
}

// Join a study group with capacity check / Включване в учебна група с проверка за капацитет
export async function joinGroup(groupId, userId) {
  await ensureStudyGroupsTable();
  const normalizedGroupId = Number(groupId);
  const normalizedUserId = Number(userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const groupRes = await client.query(
      'SELECT id, max_capacity FROM study_groups WHERE id = $1 FOR UPDATE',
      [normalizedGroupId]
    );
    if (groupRes.rows.length === 0) {
      const err = new Error('Group not found / Групата не е намерена');
      err.code = 'GROUP_NOT_FOUND';
      throw err;
    }

    const maxCapacity = Number(groupRes.rows[0].max_capacity);

    const existingMember = await client.query(
      'SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 LIMIT 1',
      [normalizedGroupId, normalizedUserId]
    );

    if (existingMember.rows.length === 0) {
      const countRes = await client.query(
        'SELECT COUNT(*)::int AS cnt FROM group_members WHERE group_id = $1',
        [normalizedGroupId]
      );
      if (countRes.rows[0].cnt >= maxCapacity) {
        const err = new Error('This group is full');
        err.code = 'GROUP_FULL';
        throw err;
      }

      await client.query(
        'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
        [normalizedGroupId, normalizedUserId]
      );
    }

    await client.query('COMMIT');
    return await getGroupById(normalizedGroupId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Leave a study group / Напускане на учебна група
export async function leaveGroup(groupId, userId) {
  await ensureStudyGroupsTable();
  const normalizedGroupId = Number(groupId);
  const normalizedUserId = Number(userId);

  await pool.query(
    'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2',
    [normalizedGroupId, normalizedUserId]
  );

  return await getGroupById(normalizedGroupId);
}