import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { collectRegularFiles, isBinaryFile } from "../scripts/audit-files.mjs";

const runFile = promisify(execFile);

test("Given missing roots, symlinks, binary files, and a FIFO, when auditing files, then only regular files are collected", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "audit-files-"));
  context.after(async () => rm(directory, { force: true, recursive: true }));

  const textFile = join(directory, "fixture.txt");
  const binaryFile = join(directory, "fixture.bin");
  const targetDirectory = join(directory, "target");
  const symlinkDirectory = join(directory, "linked-target");
  const fifo = join(directory, "fixture.fifo");

  await writeFile(textFile, "safe text", "utf8");
  await writeFile(binaryFile, Buffer.from([0, 1, 2]));
  await mkdir(targetDirectory);
  await writeFile(
    join(targetDirectory, "outside.txt"),
    "do not traverse",
    "utf8",
  );
  await symlink(targetDirectory, symlinkDirectory, "dir");
  await runFile("mkfifo", [fifo]);

  let timer;
  try {
    const files = await Promise.race([
      collectRegularFiles([join(directory, "missing"), directory]),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("FIFO traversal timed out")),
          500,
        );
      }),
    ]);

    assert.deepEqual(files, [
      binaryFile,
      textFile,
      join(targetDirectory, "outside.txt"),
    ]);
  } finally {
    clearTimeout(timer);
  }

  assert.equal(await isBinaryFile(binaryFile), true);
  assert.equal(await isBinaryFile(textFile), false);
});
