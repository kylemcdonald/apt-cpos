#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  decodeCpos,
  inspectCpos,
} from "./cpos.js";

const DEFAULT_TARGET_POINTS = 4_000_000;

function pointsToPos(points) {
  const output = new ArrayBuffer(points.length * 4);
  const view = new DataView(output);
  for (let index = 0; index < points.length; index += 1) {
    view.setFloat32(index * 4, points[index], false);
  }
  return output;
}

function usage() {
  console.error(`usage:
  node javascript/cli.mjs encode INPUT.pos OUTPUT.cpos [--target-points N]
  node javascript/cli.mjs decode INPUT.cpos OUTPUT.pos
  node javascript/cli.mjs inspect INPUT.cpos`);
  process.exitCode = 2;
}

const [command, inputPath, outputPath, ...rest] = process.argv.slice(2);
if (!command || !inputPath) {
  usage();
} else if (command === "encode") {
  if (!outputPath) {
    usage();
  } else {
    let targetPoints = DEFAULT_TARGET_POINTS;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === "--target-points" && rest[index + 1]) {
        targetPoints = Number(rest[index + 1]);
        index += 1;
      } else {
        throw new Error(`unknown argument: ${rest[index]}`);
      }
    }
    const python = process.env.PYTHON || "python3";
    const completed = spawnSync(
      python,
      [
        "-m",
        "cpos.cli",
        "encode",
        inputPath,
        outputPath,
        "--target-points",
        String(targetPoints),
      ],
      { cwd: new URL("..", import.meta.url), stdio: "inherit" },
    );
    if (completed.error) throw completed.error;
    if (completed.status !== 0) {
      throw new Error(`Python CPOS encoder exited with status ${completed.status}`);
    }
  }
} else if (command === "decode") {
  if (!outputPath) {
    usage();
  } else {
    const source = readFileSync(inputPath);
    const decoded = await decodeCpos(source);
    writeFileSync(outputPath, new Uint8Array(pointsToPos(decoded.points)));
  }
} else if (command === "inspect") {
  const source = readFileSync(inputPath);
  const header = inspectCpos(source);
  console.log(JSON.stringify({
    ...header,
    containerVersion: header.containerVersion.join("."),
    algorithmVersion: header.algorithmVersion.join("."),
    payloadCrc32: header.payloadCrc32.toString(16).padStart(8, "0"),
  }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
} else {
  usage();
}
