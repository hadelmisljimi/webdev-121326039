const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Четене на файла с лекциите веднъж при стартиране / Read lectures once at start-up
const lectures = JSON.parse(fs.readFileSync(path.join(__dirname, 'lectures.json'), 'utf8'));

// Помощна функция за текстов отговор на инструмент / Helper for tool text responses
function textResult(id, text, isError = false) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      isError,
    },
  };
}

// Списък с инструменти / List of MCP tools
const tools = [
  {
    name: 'find_lecture',
    description: 'Връща заглавието и темите на дадена лекция по нейния номер от 1 до 12. / Returns lecture title and topics by number (1..12).',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'Номер на лекция (1 до 12) / Lecture number (1 to 12)' },
      },
      required: ['number'],
    },
  },
  {
    name: 'list_lectures',
    description: 'Извежда номера и заглавието на всяка лекция в курса. / Lists the number and title of every lecture.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_study_groups',
    description: 'Извежда списък с всички учебни групи, техните теми и брой членове. / Lists active study groups, subjects, and member counts.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'find_study_group_by_id',
    description: 'Връща детайли за конкретна учебна група по нейното ID. / Returns details for a specific study group by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'ID на учебната група / Study group ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_study_group',
    description: 'Създава нова учебна група с подадените заглавие, предмет и максимален капацитет. / Creates a new study group.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Име на групата / Group title' },
        subject: { type: 'string', description: 'Предмет или тема / Course subject' },
        max_capacity: { type: 'integer', description: 'Максимален брой членове / Maximum member capacity' },
      },
      required: ['title', 'subject', 'max_capacity'],
    },
  },
];

// Изпращане на отговор като един ред JSON към stdout / Write single JSON line to stdout
function send(reply) {
  process.stdout.write(JSON.stringify(reply) + '\n');
}

// Зареждане на слоя с услугите / Load service layer module
async function loadGroupService() {
  const servicePath = path.resolve(__dirname, '../services/groupService.js');
  return import(pathToFileURL(servicePath).href);
}

// Главна функция за обработка на JSON-RPC съобщения / Main message handler
async function handle(msg) {
  if (!msg || typeof msg !== 'object') {
    return null;
  }

  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'lectures-and-groups', version: '0.2.0' },
      },
    };
  }

  if (msg.method === 'notifications/initialized') {
    return null;
  }

  if (msg.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools },
    };
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};
    const caller = msg.params?.context?.user || msg.params?._meta?.caller || 'authenticated-member';

    if (name === 'find_lecture') {
      const lectureNumber = Number(args.number);
      const lecture = lectures.find((l) => l.number === lectureNumber);
      if (!lecture) {
        return textResult(
          msg.id,
          `Няма намерена лекция с номер ${args.number}. Курсът съдържа лекции от 1 до 12. / Lecture ${args.number} not found (valid range: 1..12).`,
          true
        );
      }
      return textResult(
        msg.id,
        `Лекция ${lecture.number}: ${lecture.title}. Теми: ${lecture.topics}`,
        false
      );
    }

    if (name === 'list_lectures') {
      const listText = lectures.map((l) => `${l.number}. ${l.title}`).join('\n');
      return textResult(msg.id, listText, false);
    }

    try {
      const groupService = await loadGroupService();

      if (name === 'list_study_groups') {
        const groups = await groupService.listGroups();
        return textResult(msg.id, JSON.stringify(groups), false);
      }

      if (name === 'find_study_group_by_id') {
        if (args.id === undefined || args.id === null || Number.isNaN(Number(args.id))) {
          return textResult(msg.id, 'Липсва или е невалидно ID на групата. / Missing or invalid group id.', true);
        }
        const group = await groupService.getGroupById(Number(args.id));
        if (!group) {
          return textResult(msg.id, `Не е намерена група с ID ${args.id}. / Group ${args.id} not found.`, true);
        }
        return textResult(msg.id, JSON.stringify(group), false);
      }

      if (name === 'create_study_group') {
        const capacity = Number(args.max_capacity);
        if (!args.title || !args.subject || !Number.isInteger(capacity) || capacity <= 0) {
          return textResult(
            msg.id,
            'Невалидни аргументи: изискват се title, subject и положително цяло число max_capacity. / Invalid arguments for create_study_group.',
            true
          );
        }
        const newGroup = await groupService.createGroup({
          title: String(args.title).trim(),
          subject: String(args.subject).trim(),
          max_capacity: capacity,
          creator: caller,
        });
        return textResult(
          msg.id,
          `Успешно създадена нова учебна група от ${caller}: ${JSON.stringify(newGroup)}`,
          false
        );
      }
    } catch (error) {
      return textResult(
        msg.id,
        `Грешка при изпълнение на услугата: ${error.message} / Service error: ${error.message}`,
        true
      );
    }

    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32602, message: `Непознат инструмент: ${name}` },
    };
  }

  if (msg.id !== undefined) {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Непознат метод: ${msg.method}` },
    };
  }

  return null;
}

// Четене от stdin ред по ред / Read JSON-RPC lines from stdin
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    console.error('получено: ' + line);
    const reply = await handle(JSON.parse(line));
    if (reply) send(reply);
  } catch (err) {
    console.error('Грешка при обработка на ред:', err.message);
  }
});