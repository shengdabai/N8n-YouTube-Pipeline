const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const root = process.env.WORKFLOW_ROOT || path.join(__dirname, '..');
const load = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const video = load('分镜视频生成与自动粗剪.json');
const youtube = load('YouTube对标频道爆款视频采集.json');
const scenes = load('视频分镜拆解与AI图片生成.json');
const node = (flow, name) => flow.nodes.find(n => n.name === name);
const items = rows => rows.map(json => ({ json }));
async function run(flow, name, rows = [], extra = {}) {
  const context = { Buffer, URL, require, setTimeout, clearTimeout, $json: rows[0],
    $input: { all: () => items(rows), first: () => items(rows)[0] }, ...extra };
  const result = await vm.runInNewContext(`(async () => {${node(flow, name).parameters.jsCode}\n})()`, context);
  return JSON.parse(JSON.stringify(result));
}
const fakeFs = { mkdirSync() {}, writeFileSync() {} };

test('HTML treats sheet and model content as text and returns n8n binary data', async () => {
  const attack = '<img src=x onerror=alert(1)>"\'&';
  const [result] = await run(video, '生成HTML任务清单', [{
    图片URL: 'https://example.com/" onload="alert(1)', 分镜序号: attack,
    画面描述: attack, video_prompt: attack,
  }], { require: name => name === 'fs' ? fakeFs : require(name) });
  const html = Buffer.from(result.binary.data.data, 'base64').toString();
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('" onload="alert'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes("writeText('<img"));
  assert.equal(result.binary.data.mimeType, 'text/html');
  assert.ok(html.includes('src="https://example.com/'));
});

test('HTML blocks active image URL schemes', async () => {
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>']) {
    const [result] = await run(video, '生成HTML任务清单', [{ 图片URL: url }], {
      require: name => name === 'fs' ? fakeFs : require(name),
    });
    const html = Buffer.from(result.binary.data.data, 'base64').toString();
    assert.ok(html.includes('<img src=""'));
  }
});

test('v3 loops run work on output 1 and aggregate on output 0', () => {
  for (const [flow, name, done, loop] of [
    [video, '遍历分镜', '生成HTML任务清单', 'Gemini生成视频提示词'],
    [video, '遍历视频', '生成文件列表', '下载视频片段'],
    [youtube, '遍历频道', '按播放量排序', '提取频道标识'],
    [scenes, '遍历分镜', '生成手动操作文档', 'Gemini元素替换'],
  ]) {
    assert.equal(flow.connections[name].main[0][0].node, done);
    assert.equal(flow.connections[name].main[1][0].node, loop);
  }
});

test('channel lookup accepts search object IDs and rejects missing IDs', async () => {
  const extra = { $: () => ({ item: { json: { channelName: 'demo' } } }) };
  const [result] = await run(youtube, '统一频道ID', [{ items: [{ id: { channelId: 'UC123' } }] }], extra);
  assert.equal(result.json.channelId, 'UC123');
  const [direct] = await run(youtube, '统一频道ID', [{ items: [{ id: 'UC456' }] }], extra);
  assert.equal(direct.json.channelId, 'UC456');
  await assert.rejects(run(youtube, '统一频道ID', [{ items: [] }], extra), /频道ID/);
});

test('invalid model responses stop before creating scenes or clearing prompts', async () => {
  const extra = { $: () => ({ item: { json: {} } }) };
  for (const text of ['not json', '{}', '[]', '[{"scene_number":1}]']) {
    await assert.rejects(run(scenes, '解析分镜JSON', [{ candidates: [{ content: { parts: [{ text }] } }] }], extra), /分镜/);
  }
  await assert.rejects(run(video, '提取视频提示词', [{ error: { message: 'quota' } }], extra), /提示词/);
});

test('YouTube API failures stop before the sheet clear path', async () => {
  const extra = { fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: {} }) }) };
  for (const name of ['获取视频列表(循环)', '获取详情并格式化']) {
    await assert.rejects(run(youtube, name, [{ playlistId: 'x', collectedVideoIds: ['v1'] }], extra), /YouTube/);
  }
});

test('download rejects traversal and untrusted URLs before network or disk writes', async () => {
  const extra = { require: name => name === 'fs' ? new Proxy({}, {
    get() { throw new Error('unexpected filesystem access'); },
  }) : require(name) };
  for (const scene of ['../../outside', '1/../../outside', -1, 1.2, '']) {
    await assert.rejects(run(video, '下载视频片段', [{ 分镜序号: scene, 视频URL: 'https://media.example.com/a' }], extra), /分镜序号/);
  }
  for (const url of ['http://127.0.0.1/a', 'https://localhost/a', 'https://169.254.169.254/a',
    'file:///etc/passwd', 'https://untrusted.example/a']) {
    await assert.rejects(run(video, '下载视频片段', [{ 分镜序号: 1, 视频URL: url }], extra), /URL|主机/);
  }
});

test('downloads reject redirects, HTTP errors, oversized and interrupted bodies', async () => {
  const flow = JSON.parse(JSON.stringify(video));
  node(flow, '下载视频片段').parameters.jsCode = node(flow, '下载视频片段').parameters.jsCode
    .replace('YOUR_TRUSTED_VIDEO_CDN_HOST', 'media.example.com');
  for (const [status, chunks, message] of [[302, [], /下载失败/], [500, [], /下载失败/],
    [200, [Buffer.alloc(100 * 1024 * 1024 + 1)], /过大/], [200, null, /中断/]]) {
    const https = { get(url, options, callback) {
      const request = new EventEmitter();
      request.destroy = error => process.nextTick(() => request.emit('error', error));
      process.nextTick(() => {
        const response = new EventEmitter(); response.statusCode = status;
        response.destroy = error => { if (error) response.emit('error', error); };
        callback(response);
        if (status === 200) {
          if (chunks === null) response.emit('aborted');
          else { for (const chunk of chunks) response.emit('data', chunk); response.emit('end'); }
        }
      });
      return request;
    } };
    await assert.rejects(run(flow, '下载视频片段', [{ 分镜序号: 1, 视频URL: 'https://media.example.com/a' }], {
      require: name => name === 'https' ? https : require(name),
      $: () => ({ first: () => ({ json: { workspace: '/tmp/video_workspace-TEST' } }) }),
    }), message);
  }
});

test('each download run has an isolated directory and validates all scene numbers', async t => {
  const dirs = [];
  t.after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
  const requireFs = name => name === 'fs' ? {
    mkdtempSync: () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n31-test-')); dirs.push(dir); return dir; },
  } : require(name);
  const a = await run(video, '按分镜序号排序', [{ 分镜序号: 10 }, { 分镜序号: 2 }], { require: requireFs });
  const b = await run(video, '按分镜序号排序', [{ 分镜序号: 1 }], { require: requireFs });
  assert.equal(a[0].json.分镜序号, 2);
  assert.notEqual(a[0].json.workspace, b[0].json.workspace);
  await assert.rejects(run(video, '按分镜序号排序', [{ 分镜序号: '1junk' }]), /分镜序号/);
  await assert.rejects(run(video, '按分镜序号排序', [{ 分镜序号: 1 }, { 分镜序号: 1 }]), /重复/);
});

test('successful download writes only a validated, exclusive file in this run', async () => {
  const flow = JSON.parse(JSON.stringify(video));
  node(flow, '下载视频片段').parameters.jsCode = node(flow, '下载视频片段').parameters.jsCode
    .replace('YOUR_TRUSTED_VIDEO_CDN_HOST', 'media.example.com');
  let written;
  const https = { get(url, options, callback) {
    assert.equal(url.href, 'https://media.example.com/a');
    const request = new EventEmitter();
    process.nextTick(() => {
      const response = new EventEmitter(); response.statusCode = 200;
      callback(response); response.emit('data', Buffer.from('video')); response.emit('end');
    });
    return request;
  } };
  const [result] = await run(flow, '下载视频片段', [{ 分镜序号: 2, 视频URL: 'https://media.example.com/a' }], {
    require: name => name === 'https' ? https : name === 'fs' ? {
      writeFileSync: (...args) => { written = args; },
    } : require(name),
    $: () => ({ first: () => ({ json: { workspace: '/tmp/video_workspace-TEST' } }) }),
  });
  assert.equal(written[0], '/tmp/video_workspace-TEST/clip_0000000000000002.mp4');
  assert.equal(written[1].toString(), 'video');
  assert.equal(written[2].flag, 'wx');
  assert.equal(result.json.downloaded, true);
});

test('download DNS lookup rejects private answers and pins public addresses', async () => {
  const flow = JSON.parse(JSON.stringify(video));
  node(flow, '下载视频片段').parameters.jsCode = node(flow, '下载视频片段').parameters.jsCode
    .replace('YOUR_TRUSTED_VIDEO_CDN_HOST', 'media.example.com');
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.0.1', '8.8.8.8']) {
    let checked = false;
    const https = { get(url, options) {
      assert.equal(options.family, 4);
      assert.equal(options.autoSelectFamily, false);
      const request = new EventEmitter();
      process.nextTick(() => options.lookup(url.hostname, {}, (error, pinned, family) => {
        if (address === '8.8.8.8') { assert.equal(pinned, address); assert.equal(family, 4); }
        else assert.match(error.message, /非公网/);
        checked = true;
        request.emit('error', new Error('test stopped before socket connection'));
      }));
      return request;
    } };
    await assert.rejects(run(flow, '下载视频片段', [{ 分镜序号: 1, 视频URL: 'https://media.example.com/a' }], {
      require: name => name === 'https' ? https : name === 'dns' ? {
        lookup: (host, options, callback) => { assert.equal(options.family, 4); callback(null, [{ address, family: 4 }]); },
      } : require(name),
      $: () => ({ first: () => ({ json: { workspace: '/tmp/video_workspace-TEST' } }) }),
    }), /test stopped/);
    assert.equal(checked, true);
  }
});

test('configured IP literals cannot bypass DNS validation', async () => {
  for (const host of ['127.0.0.1', '[::1]', '169.254.169.254']) {
    const flow = JSON.parse(JSON.stringify(video));
    node(flow, '下载视频片段').parameters.jsCode = node(flow, '下载视频片段').parameters.jsCode
      .replace('YOUR_TRUSTED_VIDEO_CDN_HOST', host);
    await assert.rejects(run(flow, '下载视频片段', [{ 分镜序号: 1, 视频URL: `https://${host}/a` }]), /URL/);
  }
});

test('file list uses numeric order and ignores files outside the run directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n31-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = node(video, '生成文件列表').parameters.command;
  const shell = vm.runInNewContext(command.slice(3, -2), {
    $: () => ({ first: () => ({ json: { workspace: dir } }) }),
  });
  fs.writeFileSync(path.join(dir, 'clip_0000000000000010.mp4'), 'ten');
  fs.writeFileSync(path.join(dir, 'clip_0000000000000002.mp4'), 'two');
  const result = spawnSync('/bin/sh', ['-c', shell]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(fs.readFileSync(path.join(dir, 'filelist.txt'), 'utf8'),
    "file 'clip_0000000000000002.mp4'\nfile 'clip_0000000000000010.mp4'\n");
});

test('API request JSON preserves quotes, newlines and backslashes in input', () => {
  const value = '"\\\n</script> {{ not an expression }}';
  for (const flow of [video, scenes]) for (const n of flow.nodes.filter(n => n.parameters.jsonBody)) {
    const expression = n.parameters.jsonBody;
    assert.ok(expression.startsWith('={{'));
    const body = vm.runInNewContext(expression.slice(3, -2), { $json: new Proxy({}, { get: () => value }) });
    const parsed = JSON.parse(body);
    const text = parsed.prompt ?? parsed.contents[0].parts[0].text;
    assert.ok(text.includes(value), n.name);
  }
});

test('FFmpeg failure propagates and cannot run cleanup', () => {
  const command = node(video, 'FFmpeg拼接视频').parameters.command;
  assert.ok(!command.includes('| tail'));
  const shell = command.startsWith('=')
    ? vm.runInNewContext(command.slice(3, -2), { $: () => ({ first: () => ({ json: { workspace: '/tmp/video_workspace-TEST' } }) }) })
    : command;
  const result = spawnSync('/bin/sh', ['-c', shell], { env: { PATH: '/nonexistent' } });
  assert.notEqual(result.status, 0);
});
