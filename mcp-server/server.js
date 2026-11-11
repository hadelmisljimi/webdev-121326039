
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

// Четене на файла с лекциите веднъж при стартиране
const lectures = JSON.parse(fs.readFileSync(path.join(__dirname, 'lectures.json'), 'utf8'));

// Помощна функция за формат на отговора на инструмента (текстов отговор + isError флаг)
function textResult(id, text, isError) {
  return {
    jsonrpc: '2.0',
    id: id,
    result: {
      content: [{ type: 'text', text: text }],
      isError: isError
    }
  };
}

// Списък с инструменти, които сървърът предлага
const tools = [
  {
    name: 'find_lecture',
    description: 'Връща заглавието и темите на дадена лекция по нейния номер от 1 до 10.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer', description: 'Номер на лекция, от 1 до 10' } },
      required: ['number'],
    },
  },
  {
    name: 'list_lectures',
    description: 'Извежда номера и заглавието на всяка лекция в курса.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_study_groups',
    description: 'Извежда списък с всички учебни групи, техните теми и брой членове.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_study_group_by_id',
    description: 'Връща детайли за конкретна учебна група по нейното ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'ID на учебната група' } },
      required: ['id'],
    },
  },
  {
    name: 'create_study_group',
    description: 'Създава нова учебна група с подадените заглавие, предмет и максимален капацитет.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Име на групата' },
        subject: { type: 'string', description: 'Предмет или тема' },
        max_capacity: { type: 'integer', description: 'Максимален брой членове' }
      },
      required: ['title', 'subject', 'max_capacity'],
    },
  },
];

// Изпращане на отговора като един ред JSON на стандартния изход (stdout)
function send(reply) {
  process.stdout.write(JSON.stringify(reply) + '\n');
}

// Главна функция за обработка на съобщения и грешки
async function handle(msg) {
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'lectures-and-groups', version: '0.2.0' },
      },
    };
  }

  if (msg.method === 'notifications/initialized') {
    return null; // Нотификация: няма ID и не изисква отговор
  }

  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: tools } };
  }

  if (msg.method === 'tools/call') {
    const name = msg.params.name;
    const args = msg.params.arguments || {};

    // MCP сървърът знае кой извиква инструмента (контекст / caller)
    const caller = msg.params.context?.user || msg.params._meta?.caller || 'authenticated-member';

    if (name === 'find_lecture') {
      const lecture = lectures.find((l) => l.number === args.number);
      if (!lecture) {
        return textResult(msg.id, 'Няма намерена лекция с номер ' + args.number + '. Курсът съдържа лекции от 1 до 10.', true);
      }
      return textResult(msg.id, 'Лекция ' + lecture.number + ': ' + lecture.title + '. Теми: ' + lecture.topics, false);
    }

    if (name === 'list_lectures') {
      return textResult(msg.id, lectures.map((l) => l.number + '. ' + l.title).join('\n'), false);
    }

    // Динамично зареждане на слоя за услуги (избягва грешки при стартиране на сървъра)
    try {
      const groupService = await import('../services/groupService.js');

      if (name === 'list_study_groups') {
        const groups = await groupService.listGroups();
        return textResult(msg.id, JSON.stringify(groups), false);
      }

      if (name === 'find_study_group_by_id') {
        const group = await groupService.getGroupById(args.id);
        return textResult(msg.id, JSON.stringify(group), false);
      }

      if (name === 'create_study_group') {
        const newGroup = await groupService.createGroup({ ...args, creator: caller });
        return textResult(msg.id, 'Успешно създадена нова учебна група от ' + caller + ': ' + JSON.stringify(newGroup), false);
      }
    } catch (error) {
      return textResult(msg.id, 'Грешка при изпълнение на услугата: ' + error.message, true);
    }

    // Непознат инструмент: грешка в протокола -32602
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Непознат инструмент: ' + name } };
  }

  if (msg.id !== undefined) {
    // Непознат метод: грешка в протокола -32601
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Непознат метод: ' + msg.method } };
  }

  return null;
}

// Четене от стандартния вход (stdin)
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  try {
    console.error('получено: ' + line);
    const reply = await handle(JSON.parse(line));
    if (reply) send(reply);
  } catch (err) {
    console.error('Грешка при обработка на ред:', err);
  }
});