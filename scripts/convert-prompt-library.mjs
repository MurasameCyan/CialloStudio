/**
 * 把本地词库 HTML 转成创作台「模板」弹窗可导入的 JSON。
 *
 * Run: node scripts/convert-prompt-library.mjs <输入.html> [输出.json]
 * 不传输出路径则打印到 stdout，可直接复制进弹窗的导入框。
 *
 * 源文件里 `const LIB = {...}` / `const EROTIC_CATEGORIES = {...}` 是纯对象字面量，
 * 直接截出来交给 JS 求值，不另写解析器。
 * ponytail: 只认这两个变量名与花括号配对；源文件结构变了就得改这里，
 *   真要通用得上 acorn 之类的 AST 解析——为一次性转换不值得。
 */
import { readFileSync, writeFileSync } from "node:fs";

/** 从 `const <name> = {` 起按花括号配对截到对应的 `}`，跳过字符串与注释里的括号 */
function extractObjectLiteral(source, name) {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) throw new Error(`源文件里找不到 const ${name}`);
  const open = source.indexOf("{", start);
  if (open < 0) throw new Error(`const ${name} 之后没有 {`);

  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];

    if (quote) {
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i) + 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`const ${name} 的花括号没有闭合`);
}

function evalLiteral(literal, label) {
  try {
    return new Function(`return (${literal});`)();
  } catch (err) {
    throw new Error(`${label} 求值失败: ${err.message}`);
  }
}

/** 分类名与单选/多选：单选=互斥项（姿势、服装），多选=可叠加项（细节、氛围） */
const CATEGORY_META = {
  poses: { name: "姿势", multi: false },
  clothings: { name: "服装", multi: false },
  motions: { name: "动作幅度", multi: false },
  cameras: { name: "镜头", multi: false },
  expressions: { name: "表情", multi: false },
  characters: { name: "角色", multi: false },
  bodyHot: { name: "身体修饰", multi: true },
  tightHot: { name: "布料张力", multi: true },
  atmosphere: { name: "氛围", multi: true },
};

const EROTIC_NAMES = {
  sweat: "汗湿光泽",
  fabric: "布料贴合",
  lighting: "光影勾勒",
  feedback: "弹性颤动",
};

function toItems(list) {
  const seen = new Set();
  const items = [];
  for (const entry of list) {
    const name = typeof entry === "string" ? entry : String(entry?.name ?? "").trim();
    const text = typeof entry === "string" ? entry : String(entry?.core ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push({ name: name || text, text });
  }
  return items;
}

const [, , inputPath, outputPath] = process.argv;
if (!inputPath) {
  console.error("用法: node scripts/convert-prompt-library.mjs <输入.html> [输出.json]");
  process.exit(1);
}

const source = readFileSync(inputPath, "utf8");
const lib = evalLiteral(extractObjectLiteral(source, "LIB"), "LIB");
const erotic = evalLiteral(extractObjectLiteral(source, "EROTIC_CATEGORIES"), "EROTIC_CATEGORIES");

const categories = [];
for (const [key, meta] of Object.entries(CATEGORY_META)) {
  const list = lib[key];
  if (!Array.isArray(list)) {
    console.error(`跳过 ${key}：源文件里不是数组`);
    continue;
  }
  const items = toItems(list);
  if (items.length) categories.push({ id: key, name: meta.name, multi: meta.multi, items });
}

const eroticItems = toItems(
  Object.entries(erotic).map(([key, text]) => ({ name: EROTIC_NAMES[key] ?? key, core: text })),
);
if (eroticItems.length) {
  categories.push({ id: "erotic", name: "色气细节", multi: true, items: eroticItems });
}

const json = JSON.stringify({ categories }, null, 2);
if (outputPath) {
  writeFileSync(outputPath, `${json}\n`, "utf8");
  const total = categories.reduce((sum, c) => sum + c.items.length, 0);
  console.error(`已写入 ${outputPath}：${categories.length} 个分类 / ${total} 条`);
} else {
  process.stdout.write(`${json}\n`);
}
