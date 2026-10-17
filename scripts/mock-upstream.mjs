/**
 * Mock OpenAI 兼容上游，用于端到端自测。
 * 启动: node scripts/mock-upstream.mjs 8099
 */
import http from 'node:http';

const PORT = Number(process.argv[2]) || 8099;

function reply(content, extra = {}) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  const send = (obj, status = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (url.pathname === '/v1/models' || url.pathname === '/models') {
    return send({
      object: 'list',
      data: [
        { id: 'mock-chat', object: 'model', name: 'Mock Chat' },
        { id: 'mock-vision', object: 'model', name: 'Mock Vision' },
        { id: 'mock-text-only', object: 'model', name: 'Mock Text Only' },
      ],
    });
  }

  if (!url.pathname.endsWith('/chat/completions')) {
    return send({ error: { message: 'not found' } }, 404);
  }

  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || '{}');
  const model = body.model || '';
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content ?? '') }];
  const textPrompt = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  const hasImage = parts.some((p) => p.type === 'image_url');

  // 模拟“纯文本模型”拒绝图片
  if (hasImage && model.includes('text-only')) {
    return send({ error: { message: 'model does not support image input' } }, 400);
  }

  // 流式
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

    // 流式 + 工具：按 OpenAI 规范用 delta.tool_calls 分片下发
    if (Array.isArray(body.tools) && body.tools.length) {
      if (model === 'mock-no-tools') {
        for (const c of ['I ', 'cannot ', 'call ', 'tools.']) {
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c } }] })}\n\n`);
        }
      } else {
        const args = JSON.stringify({ location: 'San Francisco' });
        res.write(
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] })}\n\n`
        );
        for (const piece of args.match(/.{1,8}/g) || []) {
          res.write(
            `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] })}\n\n`
          );
        }
      }
      res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { total_tokens: 20 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const chunks = ['1', '2', '3', '4', '5'];
    for (const c of chunks) {
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c + ',' } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 20 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  // JSON 模式
  if (body.response_format?.type === 'json_object') {
    return send(reply('{"name":"Ada","age":36}'));
  }

  // 工具调用
  if (Array.isArray(body.tools) && body.tools.length) {
    const strictOk = model !== 'mock-no-tools';
    if (!strictOk) return send(reply('I cannot call tools.'));
    return send(
      reply(null, {
        tool_calls: [
          {
            id: 'call_mock',
            type: 'function',
            function: { name: 'get_weather', arguments: JSON.stringify({ location: 'San Francisco' }) },
          },
        ],
      })
    );
  }

  // 视觉严格项
  if (hasImage && /2x2 grid/i.test(textPrompt)) {
    const wrong = model === 'mock-bad-vision';
    return send(reply(wrong ? 'red, green, blue, yellow' : 'red, blue, green, yellow'));
  }

  // 视觉 Chatbox 项
  if (hasImage) return send(reply('The image is a single red pixel.'));

  // 思考题
  if (/17 sheep/i.test(textPrompt)) {
    const wrong = model === 'mock-dumb';
    return send(
      reply(`<think>17 sheep, all but 9 ran away, so 9 remain.</think>\nANSWER: ${wrong ? 8 : 9}`)
    );
  }

  if (/count from 1 to 5/i.test(textPrompt)) return send(reply('1,2,3,4,5'));
  return send(reply('Hi! How can I help you today?'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock upstream on http://127.0.0.1:${PORT}/v1`);
});
