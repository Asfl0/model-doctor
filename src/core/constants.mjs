/**
 * Viper 测试素材常量。
 * 说明：视觉素材沿用 Chatbox `src/renderer/utils/model-tester.ts` 的同一张 1x1 PNG，
 * 保证与 Chatbox 的视觉探测行为一致（只验证多模态通道能否被接受）。
 */

// Chatbox 原始常量：1x1 红色像素 PNG
export const CHATBOX_TEST_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

export const CHATBOX_TEST_IMAGE_DATA_URL = `data:image/png;base64,${CHATBOX_TEST_IMAGE_BASE64}`;

/**
 * 增强版视觉素材：4 个色块的 PNG，带可判分答案（左上红、右上蓝、左下绿、右下黄）。
 * 由 build-test-assets.mjs 生成，缺失时回退到 Chatbox 素材。
 */
export const VISION_GRID_ANSWER = {
  expectedColors: ['red', 'blue', 'green', 'yellow'],
  prompt:
    'Look at the image. It contains a 2x2 grid of solid color squares. ' +
    'Answer with only the four colors in reading order (top-left, top-right, bottom-left, bottom-right), ' +
    'comma separated, in English.',
};

/** 思考能力探测题：答案唯一且便于正则抽取 */
export const REASONING_PROMPT =
  'A farmer has 17 sheep. All but 9 run away. How many sheep are left? ' +
  'Think step by step inside  thinking...<｜end▁of▁thinking｜>, then give the final number on its own line prefixed with "ANSWER:".';

export const REASONING_EXPECTED = 9;

/** 工具调用探测 */
export const TOOL_PROMPT = 'What is the weather in San Francisco? Use the get_weather tool.';

export const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: 'City name' } },
      required: ['location'],
      additionalProperties: false,
    },
  },
};

/** JSON 模式探测 */
export const JSON_PROMPT =
  'Return a JSON object with keys "name" (string) and "age" (number) describing a person named Ada aged 36. JSON only, no prose.';

export const JSON_REQUIRED_KEYS = ['name', 'age'];
