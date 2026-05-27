#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_PACKAGE = process.env.QUEST_PACKAGE || "com.bizonvr.questagent";

const server = new McpServer({
  name: "quest-agent-tools",
  version: "1.0.0",
});

function textOutput(text) {
  return {
    content: [
      {
        type: "text",
        text: String(text || "(empty)").slice(-16000),
      },
    ],
  };
}

async function run(command, args = [], options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeout || 30000,
      maxBuffer: 1024 * 1024 * 12,
      env: process.env,
    });

    return textOutput(
      [
        `$ ${command} ${args.join(" ")}`,
        "",
        result.stdout || "",
        result.stderr ? `STDERR:\n${result.stderr}` : "",
      ].join("\n")
    );
  } catch (error) {
    return textOutput(
      [
        `$ ${command} ${args.join(" ")}`,
        "",
        "FAILED",
        `code: ${error.code ?? "unknown"}`,
        "",
        error.stdout ? `STDOUT:\n${error.stdout}` : "",
        error.stderr ? `STDERR:\n${error.stderr}` : "",
        error.message ? `MESSAGE:\n${error.message}` : "",
      ].join("\n")
    );
  }
}

server.tool(
  "adb_devices",
  "Показать подключенные ADB устройства. Нужно, чтобы проверить, виден ли Quest 2.",
  {},
  async () => {
    return run("adb", ["devices", "-l"]);
  }
);

server.tool(
  "list_packages",
  "Показать установленные приложения на Quest. Можно передать query, например bizon, quest, agent.",
  {
    query: z.string().optional(),
  },
  async ({ query }) => {
    const result = await run("adb", ["shell", "pm", "list", "packages"]);
    if (!query) return result;

    const lines = result.content[0].text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
      .join("\n");

    return textOutput(lines || `По запросу "${query}" пакеты не найдены.`);
  }
);

server.tool(
  "start_app",
  "Запустить установленное приложение на Quest через monkey. По умолчанию запускает QUEST_PACKAGE.",
  {
    packageName: z.string().optional(),
  },
  async ({ packageName }) => {
    const pkg = packageName || DEFAULT_PACKAGE;
    return run("adb", [
      "shell",
      "monkey",
      "-p",
      pkg,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
  }
);

server.tool(
  "stop_app",
  "Остановить приложение на Quest. По умолчанию останавливает QUEST_PACKAGE.",
  {
    packageName: z.string().optional(),
  },
  async ({ packageName }) => {
    const pkg = packageName || DEFAULT_PACKAGE;
    return run("adb", ["shell", "am", "force-stop", pkg]);
  }
);

server.tool(
  "clear_logcat",
  "Очистить logcat перед новым тестом.",
  {},
  async () => {
    return run("adb", ["logcat", "-c"]);
  }
);

server.tool(
  "read_logcat",
  "Прочитать последние строки logcat. Можно указать lines и filter.",
  {
    lines: z.number().int().min(50).max(3000).default(500),
    filter: z.string().optional(),
  },
  async ({ lines, filter }) => {
    const result = await run("adb", ["logcat", "-d", "-t", String(lines)], {
      timeout: 30000,
    });

    const text = result.content[0].text;

    if (!filter) return textOutput(text);

    const filtered = text
      .split("\n")
      .filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
      .join("\n");

    return textOutput(filtered || `По фильтру "${filter}" ничего не найдено.`);
  }
);

server.tool(
  "read_crashes",
  "Показать ошибки и краши из logcat: AndroidRuntime, FATAL EXCEPTION, ANR, Exception, Error.",
  {
    lines: z.number().int().min(100).max(5000).default(1500),
  },
  async ({ lines }) => {
    const result = await run("adb", ["logcat", "-d", "-t", String(lines)], {
      timeout: 30000,
    });

    const keywords = [
      "AndroidRuntime",
      "FATAL EXCEPTION",
      "ANR",
      "Exception",
      "Error",
      "crash",
      DEFAULT_PACKAGE,
    ];

    const filtered = result.content[0].text
      .split("\n")
      .filter((line) =>
        keywords.some((keyword) =>
          line.toLowerCase().includes(keyword.toLowerCase())
        )
      )
      .join("\n");

    return textOutput(filtered || "Краш/ошибки в последних логах не найдены.");
  }
);

server.tool(
  "quest_info",
  "Показать информацию о Quest: модель, Android, SDK, состояние экрана.",
  {},
  async () => {
    const model = await run("adb", ["shell", "getprop", "ro.product.model"]);
    const android = await run("adb", ["shell", "getprop", "ro.build.version.release"]);
    const sdk = await run("adb", ["shell", "getprop", "ro.build.version.sdk"]);
    const display = await run("adb", ["shell", "dumpsys", "power"]);

    return textOutput(
      [
        "--- model ---",
        model.content[0].text,
        "--- android ---",
        android.content[0].text,
        "--- sdk ---",
        sdk.content[0].text,
        "--- power/display ---",
        display.content[0].text
          .split("\n")
          .filter((line) =>
            ["Display Power", "mWakefulness", "mHolding"].some((x) =>
              line.includes(x)
            )
          )
          .join("\n"),
      ].join("\n")
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
