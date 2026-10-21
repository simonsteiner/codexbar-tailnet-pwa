import { Updater, parseSha256File, unsafeTarEntry, missingLibraries, assetName, linuxArch } from "./updater.mjs";
import assert from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

/** A release tarball whose CodexBarCLI is a shell script; `cost` decides how its smoke test goes. */
async function makeRelease(dir, version, { cost = "echo '[]'", extra } = {}) {
  const src = await fs.mkdtemp(path.join(dir, "src-"));
  await fs.writeFile(path.join(src, "CodexBarCLI"), `#!/bin/sh\ncase "$1" in\n  --version) echo "CodexBar ${version}" ;;\n  cost) ${cost} ;;\nesac\n`, { mode: 0o755 });
  await fs.symlink("CodexBarCLI", path.join(src, "codexbar"));
  await fs.mkdir(path.join(src, "CodexBar_CodexBarCore.bundle"));
  await fs.writeFile(path.join(src, "VERSION"), `${version}\n`);
  if (extra) await extra(src);
  const tag = `v${version}`;
  const name = assetName(tag, linuxArch());
  const file = path.join(dir, name);
  execFileSync("tar", ["-czf", file, "-C", src, "."]);
  const buf = await fs.readFile(file);
  return { tag, name, buf, sha: createHash("sha256").update(buf).digest("hex") };
}

async function runTests() {
  console.log("Running updater.mjs tests...");

  // 1: the parsers
  {
    const hex = "4a88cace99b235050215f66fd1f79f86a4f970c72d52c73f8d31ed607ed837a2";
    assert.strictEqual(parseSha256File(`${hex}  CodexBarCLI-v0.79.0-linux-x86_64.tar.gz\n`, "CodexBarCLI-v0.79.0-linux-x86_64.tar.gz"), hex);
    assert.strictEqual(parseSha256File(hex.toUpperCase(), "x"), hex);
    assert.strictEqual(parseSha256File(`${hex}  other.tar.gz`, "mine.tar.gz"), null);
    assert.strictEqual(assetName("v0.79.0", "x86_64"), "CodexBarCLI-v0.79.0-linux-x86_64.tar.gz");
    assert.strictEqual(assetName("v0.79.0", "x86_64", "musl"), "CodexBarCLI-v0.79.0-linux-musl-x86_64.tar.gz");

    // Straight from the v0.79.0 tarball
    const ok = [
      "-rwxr-xr-x runner/runner 176514536 2026-10-21 00:36 CodexBarCLI",
      "lrwxrwxrwx runner/runner         0 2026-10-21 00:36 codexbar -> CodexBarCLI",
      "drwxr-xr-x runner/runner         0 2026-10-21 00:36 CodexBar_CodexBarCore.bundle/",
      "-rw-r--r-- runner/runner      4861 2026-10-21 00:36 CodexBar_CodexBarCore.bundle/hyper.js",
    ].join("\n");
    assert.strictEqual(unsafeTarEntry(ok), null);
    assert.match(unsafeTarEntry("-rw-r--r-- a/a 1 2026-10-21 00:36 ../../.bashrc"), /escapes/);
    assert.match(unsafeTarEntry("-rw-r--r-- a/a 1 2026-10-21 00:36 /etc/passwd"), /escapes/);
    assert.match(unsafeTarEntry("lrwxrwxrwx a/a 0 2026-10-21 00:36 codexbar -> /bin/sh"), /symlink escapes/);
    assert.match(unsafeTarEntry("hrw-r--r-- a/a 0 2026-10-21 00:36 x link to y"), /unexpected entry type h/);

    assert.deepStrictEqual(missingLibraries("\tlinux-vdso.so.1 (0x1)\n\tlibxml2.so.2 => not found\n\tlibc.so.6 => /lib/libc.so.6 (0x2)\n"), ["libxml2.so.2"]);
    assert.deepStrictEqual(missingLibraries("\tnot a dynamic executable\n"), []);
    console.log("✓ Test 1 passed: sha256 files, tar listings, ldd output");
  }

  // 2-7: the whole flow, against a fake install root, fake GitHub and a fake systemd
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cbt-updater-"));
  try {
    const root = path.join(dir, "opt");
    const link = path.join(dir, "bin", "CodexBarCLI");
    await fs.mkdir(path.join(root, "0.1.0"), { recursive: true });
    await fs.mkdir(path.dirname(link));
    await fs.writeFile(path.join(root, "0.1.0", "CodexBarCLI"), "#!/bin/sh\ncase \"$1\" in --version) echo 'CodexBar 0.1.0' ;; cost) echo '[]' ;; esac\n", { mode: 0o755 });
    await fs.symlink(path.join(root, "0.1.0", "CodexBarCLI"), link);
    await fs.symlink(path.join(root, "0.1.0"), path.join(root, "current")); // a stray link, like the real root has

    // systemd stand-in: the restart counter climbs on every look while the link points at 0.3.0,
    // which is what a serve crash-looping under Restart=always looks like from `show`.
    const counter = path.join(dir, "restarts");
    await fs.writeFile(counter, "0");
    const systemctl = path.join(dir, "systemctl");
    await fs.writeFile(systemctl, `#!/bin/sh
case "$2" in
  restart) exit 0 ;;
  show)
    n=$(cat "${counter}")
    case "$(readlink "${link}")" in *0.3.0*) n=$((n + 1)); echo $n > "${counter}" ;; esac
    printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nResult=success\\nNRestarts=%s\\nMainPID=42\\nActiveEnterTimestamp=@1792574652\\n' "$n" ;;
esac
`, { mode: 0o755 });

    const releases = new Map();
    const publish = (rel, sha = rel.sha) => {
      releases.set(`${rel.tag}/${rel.name}`, rel.buf);
      releases.set(`${rel.tag}/${rel.name}.sha256`, Buffer.from(`${sha}  ${rel.name}\n`));
    };
    publish(await makeRelease(dir, "0.2.0"));
    publish(await makeRelease(dir, "0.3.0"));
    publish(await makeRelease(dir, "0.4.0", { cost: "kill -SEGV $$" })); // the 0.78.0-musl failure
    const tampered = await makeRelease(dir, "0.5.0");
    publish(tampered, "0".repeat(64));
    publish(await makeRelease(dir, "0.6.0", { extra: (src) => fs.symlink("../../../.bashrc", path.join(src, "evil")) }));

    const fetches = [];
    const fakeFetch = async (url) => {
      fetches.push(url);
      const m = url.match(/^https:\/\/github\.com\/owner\/repo\/releases\/download\/(.+)$/);
      const buf = m && releases.get(m[1]);
      return buf ? new Response(buf, { headers: { "content-length": String(buf.length) } }) : new Response("Not Found", { status: 404 });
    };

    let changes = 0;
    let quietUntil = 0;
    const u = new Updater({
      installRoot: root,
      binLink: link,
      serveUnit: "fake.service",
      repo: "owner/repo",
      fetch: fakeFetch,
      systemctl,
      verifyServe: async () => {},
      quiet: (t) => { quietUntil = t; },
      onChange: () => { changes += 1; },
      settleMs: 300,
      verifyTimeoutMs: 3000,
      pollMs: 50,
    });
    const finished = async () => {
      await until(() => u.status()?.state !== "running");
      return u.status();
    };
    const active = async () => path.basename(path.dirname(await fs.readlink(link)));
    const leftovers = async () => (await fs.readdir(root)).filter((n) => n.startsWith("."));

    assert.strictEqual(await u.unsupported(), null);

    // 2: a good release installs, switches, restarts and settles
    {
      const accepted = await u.startUpdate("v0.2.0");
      assert.strictEqual(accepted.state, "running");
      await assert.rejects(u.startUpdate("v0.2.0"), /already running/);
      const job = await finished();
      assert.strictEqual(job.state, "succeeded", job.error);
      assert.strictEqual(job.from, "0.1.0");
      assert.strictEqual(await active(), "0.2.0");
      assert.ok(changes >= 1 && quietUntil > Date.now(), "proxy told about the switch and the restart");
      assert.deepStrictEqual(await leftovers(), [], "download and staging dirs are cleaned up");
      assert.ok(job.log.some((l) => /smoke test ok/.test(l.msg)));
      console.log("✓ Test 2 passed: good release installed");
    }

    // 3: a binary that dies in the cold cost scan never goes live
    {
      await u.startUpdate("v0.4.0");
      const job = await finished();
      assert.strictEqual(job.state, "failed");
      assert.match(job.error, /SIGSEGV/);
      assert.strictEqual(await active(), "0.2.0");
      await assert.rejects(fs.access(path.join(root, "0.4.0")));
      assert.deepStrictEqual(await leftovers(), []);
      console.log("✓ Test 3 passed: smoke test failure leaves the install alone");
    }

    // 4: a binary that passes but crash-loops serve is rolled back on its own
    {
      await u.startUpdate("v0.3.0");
      const job = await finished();
      assert.strictEqual(job.state, "rolled-back");
      assert.match(job.error, /crashed and was restarted/);
      assert.strictEqual(await active(), "0.2.0");
      await fs.access(path.join(root, "0.3.0", "CodexBarCLI")); // kept, like every install
      console.log("✓ Test 4 passed: crash after switching rolls back");
    }

    // 5: a tampered download and an escaping tarball are refused before extraction
    {
      await u.startUpdate("v0.5.0");
      assert.match((await finished()).error, /sha256 mismatch/);
      await u.startUpdate("v0.6.0");
      assert.match((await finished()).error, /symlink escapes the install dir: \.\/evil/);
      await u.startUpdate("v9.9.9");
      assert.match((await finished()).error, /HTTP 404/);
      await assert.rejects(u.startUpdate("latest; rm -rf ~"), /not a release tag/);
      assert.strictEqual(await active(), "0.2.0");
      assert.ok(fetches.every((f) => f.startsWith("https://github.com/owner/repo/releases/download/")));
      console.log("✓ Test 5 passed: bad downloads refused");
    }

    // 6: installs lists real install dirs only, newest first, and switching back works
    {
      const installs = await u.installs();
      assert.deepStrictEqual(installs.map((i) => i.name), ["0.3.0", "0.2.0", "0.1.0"]);
      assert.deepStrictEqual(installs.filter((i) => i.current).map((i) => i.name), ["0.2.0"]);
      await assert.rejects(u.startRollback("0.2.0"), /already the active install/);
      await assert.rejects(u.startRollback("../../etc"), /no such install/);
      await u.startRollback("0.1.0");
      const job = await finished();
      assert.strictEqual(job.state, "succeeded", job.error);
      assert.strictEqual(await active(), "0.1.0");
      console.log("✓ Test 6 passed: switch to an older install");
    }

    // 7: reinstalling a version that already has a dir gets a fresh one beside it
    {
      await u.startUpdate("v0.2.0");
      assert.strictEqual((await finished()).state, "succeeded");
      assert.match(await active(), /^0\.2\.0-\d{8}-\d{6}$/);
      await fs.access(path.join(root, "0.2.0", "CodexBarCLI"));
      console.log("✓ Test 7 passed: existing install dirs are never overwritten");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log("\nAll updater.mjs tests passed!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
