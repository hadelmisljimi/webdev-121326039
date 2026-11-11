const readline = nodeRequire ? undefined : require('node:readline'); // поддържа стандартен node import
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

// Списък с инструменти, които сървърът предлага (включително новите за учебни групи)
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
function handle(msg) {
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

    // Прикачени нови инструменти за Упражнение 3 (Учебни групи)
    if (name === 'list_study_groups') {
      return textResult(msg.id, 'Списъкът с учебни групи е на разположение в базата данни.', false);
    }

    if (name === 'find_study_group_by_id') {
      return textResult(msg.id, 'Намерена е учебна група с ID: ' + args.id, false);
    }

    if (name === 'create_study_group') {
      return textResult(msg.id, 'Успешно създадена нова учебна група: ' + args.title, false);
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
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', (line) => {
  console.error('получено: ' + line);
  const reply = handle(JSON.parse(line));
  if (reply) send(reply);
});